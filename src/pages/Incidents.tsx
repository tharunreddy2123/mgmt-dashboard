import { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../context/ThemeContext';
import { useLayoutContext } from '../components/Layout';
import {
  getPods,
  getNodes,
  getEvents,
  getEventTime,
  getPodAge,
  type OCPod,
  type OCNode,
  type OCEvent,
} from '../lib/openshift-direct';
import {
  AlertTriangle,
  RefreshCw,
  Bot,
  Clock,
  RotateCcw,
  XCircle,
  Hourglass,
  Zap,
  ChevronDown,
  ChevronUp,
  Activity,
  Server,
  Download,
} from 'lucide-react';

// ─── types ────────────────────────────────────────────────────────────────────

const WINDOW_MS = 24 * 60 * 60 * 1000;

interface ContainerStatus {
  name: string
  ready: boolean
  restartCount: number
  state: Record<string, unknown>
  lastState: Record<string, unknown>
}

export interface Incident {
  id: string
  kind: 'Pod' | 'Node'
  name: string
  namespace: string
  node: string
  severity: 'critical' | 'warning' | 'info'
  type:
    | 'CrashLoopBackOff'
    | 'ImagePullBackOff'
    | 'OOMKilled'
    | 'Evicted'
    | 'Pending'
    | 'Failed'
    | 'Restarted'
    | 'ContainerError'
    | 'NodeNotReady'
    | 'NodePressure'
    | 'NodeCordoned'
    | 'Event'
  title: string
  detail: string
  restarts: number
  age: string
  lastSeen: Date
  containers: ContainerStatus[]
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function withinWindow(ts: string | undefined | null, now: number): boolean {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  return !isNaN(t) && now - t <= WINDOW_MS;
}

function toDate(ts: string | undefined | null, fallback: Date): Date {
  if (!ts) return fallback;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? fallback : d;
}

const IMAGE_PULL_REASONS = ['ImagePullBackOff', 'ErrImagePull', 'InvalidImageName', 'ErrImageNeverPull'];
const CRITICAL_EVENT_REASONS = ['NodeNotReady', 'Evicted', 'OOMKilling', 'SystemOOM', 'Failed', 'FailedCreate'];

type Waiting = { reason?: string; message?: string };
type Terminated = { reason?: string; exitCode?: number; finishedAt?: string };

function classifyPod(pod: OCPod, now: number): Incident | null {
  const nowDate = new Date(now);
  const containers: ContainerStatus[] = (pod.status.containerStatuses ?? []).map(cs => ({
    name: cs.name,
    ready: cs.ready,
    restartCount: cs.restartCount,
    state: cs.state ?? {},
    lastState: cs.lastState ?? {},
  }));
  const restarts = containers.reduce((s, c) => s + c.restartCount, 0);

  const base = {
    id: `Pod/${pod.metadata.namespace}/${pod.metadata.name}`,
    kind: 'Pod' as const,
    name: pod.metadata.name,
    namespace: pod.metadata.namespace,
    node: pod.spec.nodeName ?? '(unscheduled)',
    restarts,
    age: getPodAge(pod.metadata.creationTimestamp),
    containers,
  };

  const lastFinished = (c: ContainerStatus) =>
    (c.lastState?.terminated as Terminated | undefined)?.finishedAt;
  const waitingOf = (c: ContainerStatus) => c.state?.waiting as Waiting | undefined;

  // CrashLoopBackOff
  const crash = containers.find(c => waitingOf(c)?.reason === 'CrashLoopBackOff');
  if (crash) {
    const last = crash.lastState?.terminated as Terminated | undefined;
    return {
      ...base,
      severity: 'critical',
      type: 'CrashLoopBackOff',
      title: 'CrashLoopBackOff',
      detail: `Container "${crash.name}" is crash-looping. Restarts: ${crash.restartCount}.${
        last?.reason ? ` Last exit reason: ${last.reason} (code ${last.exitCode ?? '?'}).` : ''
      }`,
      lastSeen: toDate(last?.finishedAt, nowDate),
    };
  }

  // ImagePullBackOff / ErrImagePull
  const pull = containers.find(c => IMAGE_PULL_REASONS.includes(waitingOf(c)?.reason ?? ''));
  if (pull) {
    const w = waitingOf(pull)!;
    return {
      ...base,
      severity: 'critical',
      type: 'ImagePullBackOff',
      title: w.reason ?? 'ImagePullBackOff',
      detail: w.message ?? `Container "${pull.name}" cannot pull its image.`,
      lastSeen: nowDate,
    };
  }

  // OOMKilled (current or last termination within the window)
  const oom = containers.find(c => {
    const cur = c.state?.terminated as Terminated | undefined;
    const prev = c.lastState?.terminated as Terminated | undefined;
    return (cur?.reason === 'OOMKilled' && withinWindow(cur.finishedAt, now)) ||
           (prev?.reason === 'OOMKilled' && withinWindow(prev.finishedAt, now));
  });
  if (oom) {
    const t = (oom.state?.terminated ?? oom.lastState?.terminated) as Terminated;
    return {
      ...base,
      severity: 'critical',
      type: 'OOMKilled',
      title: 'OOMKilled — Out of Memory',
      detail: `Container "${oom.name}" was killed by the OOM killer (exceeded its memory limit). Restarts: ${oom.restartCount}.`,
      lastSeen: toDate(t.finishedAt, nowDate),
    };
  }

  // Evicted
  const evicted = pod.status.reason === 'Evicted' || pod.status.message?.toLowerCase().includes('evict');
  if (evicted && withinWindow(pod.status.startTime ?? pod.metadata.creationTimestamp, now)) {
    return {
      ...base,
      severity: 'critical',
      type: 'Evicted',
      title: 'Pod Evicted',
      detail: pod.status.message ?? 'Pod was evicted from the node, likely due to resource pressure.',
      lastSeen: toDate(pod.status.startTime ?? pod.metadata.creationTimestamp, nowDate),
    };
  }

  // Failed phase
  if (pod.status.phase === 'Failed' && withinWindow(pod.status.startTime ?? pod.metadata.creationTimestamp, now)) {
    return {
      ...base,
      severity: 'critical',
      type: 'Failed',
      title: 'Pod Failed',
      detail: `Pod terminated in Failed phase.${pod.status.reason ? ` Reason: ${pod.status.reason}.` : ''} ${pod.status.message ?? ''}`.trim(),
      lastSeen: toDate(pod.status.startTime ?? pod.metadata.creationTimestamp, nowDate),
    };
  }

  // Pending (ongoing)
  if (pod.status.phase === 'Pending') {
    return {
      ...base,
      severity: 'warning',
      type: 'Pending',
      title: 'Pod Stuck Pending',
      detail: 'Pod has not started. Check node resources, taints, PVCs or image pull issues.',
      lastSeen: toDate(pod.metadata.creationTimestamp, nowDate),
    };
  }

  // Other container error states (non-Running waiting state)
  const errored = containers.find(c => {
    const r = waitingOf(c)?.reason;
    return r && !['ContainerCreating', 'PodInitializing'].includes(r);
  });
  if (errored) {
    const w = waitingOf(errored)!;
    return {
      ...base,
      severity: 'warning',
      type: 'ContainerError',
      title: w.reason ?? 'Container Error',
      detail: w.message ?? `Container "${errored.name}" is in a non-running waiting state: ${w.reason}.`,
      lastSeen: nowDate,
    };
  }

  // Restarted within the last 24h
  const restarted = containers.filter(c => c.restartCount > 0 && withinWindow(lastFinished(c), now));
  if (restarted.length > 0) {
    const latest = restarted
      .map(c => ({ c, t: new Date(lastFinished(c)!).getTime() }))
      .sort((a, b) => b.t - a.t)[0];
    const last = latest.c.lastState?.terminated as Terminated;
    const recentRestarts = restarted.reduce((s, c) => s + c.restartCount, 0);
    return {
      ...base,
      severity: restarts >= 5 ? 'critical' : 'warning',
      type: 'Restarted',
      title: 'Pod Restarted',
      detail: `Container "${latest.c.name}" restarted (last exit: ${last.reason ?? 'unknown'}, code ${last.exitCode ?? '?'}). ` +
        `Total restarts: ${recentRestarts}.`,
      lastSeen: new Date(latest.t),
    };
  }

  return null;
}

function classifyNode(node: OCNode, now: number): Incident[] {
  const nowDate = new Date(now);
  const conds = node.status.conditions ?? [];
  const out: Incident[] = [];
  const base = {
    kind: 'Node' as const,
    name: node.metadata.name,
    namespace: '—',
    node: node.metadata.name,
    restarts: 0,
    age: getPodAge(node.metadata.creationTimestamp),
    containers: [] as ContainerStatus[],
  };

  const ready = conds.find(c => c.type === 'Ready');
  if (ready && ready.status !== 'True') {
    out.push({
      ...base,
      id: `Node/${node.metadata.name}/NotReady`,
      severity: 'critical',
      type: 'NodeNotReady',
      title: 'Node NotReady',
      detail: ready.message || `Node is not ready (${ready.reason || 'unknown reason'}).`,
      lastSeen: toDate(ready.lastTransitionTime, nowDate),
    });
  }

  const pressure = conds.filter(
    c => ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable'].includes(c.type) && c.status === 'True'
  );
  if (pressure.length > 0) {
    out.push({
      ...base,
      id: `Node/${node.metadata.name}/Pressure`,
      severity: 'warning',
      type: 'NodePressure',
      title: `Node under pressure: ${pressure.map(p => p.type).join(', ')}`,
      detail: pressure.map(p => p.message || p.reason).filter(Boolean).join(' | ') || 'Node reports resource pressure.',
      lastSeen: toDate(pressure[0].lastTransitionTime, nowDate),
    });
  }

  if (node.spec?.unschedulable) {
    out.push({
      ...base,
      id: `Node/${node.metadata.name}/Cordoned`,
      severity: 'warning',
      type: 'NodeCordoned',
      title: 'Node Unschedulable (cordoned)',
      detail: 'Node is marked unschedulable; no new pods will be placed on it.',
      lastSeen: nowDate,
    });
  }
  return out;
}

/** Warning events (last 24h) for pods/nodes not already covered by a state-based incident. */
function classifyEvents(events: OCEvent[], covered: Set<string>, now: number): Incident[] {
  const groups = new Map<string, OCEvent[]>();
  for (const e of events) {
    if (e.type !== 'Warning') continue;
    const kind = e.involvedObject.kind;
    if (kind !== 'Pod' && kind !== 'Node') continue;
    if (!withinWindow(getEventTime(e), now)) continue;
    const key = kind === 'Pod'
      ? `Pod/${e.involvedObject.namespace}/${e.involvedObject.name}`
      : `Node/${e.involvedObject.name}`;
    if (covered.has(key)) continue;
    const gk = `${key}/${e.reason}`;
    const list = groups.get(gk) ?? [];
    list.push(e);
    groups.set(gk, list);
  }

  const out: Incident[] = [];
  groups.forEach((list, gk) => {
    list.sort((a, b) => new Date(getEventTime(b)).getTime() - new Date(getEventTime(a)).getTime());
    const e = list[0];
    const total = list.reduce((s, x) => s + (x.count || 1), 0);
    const isNode = e.involvedObject.kind === 'Node';
    out.push({
      id: `Event/${gk}`,
      kind: isNode ? 'Node' : 'Pod',
      name: e.involvedObject.name,
      namespace: isNode ? '—' : e.involvedObject.namespace,
      node: isNode ? e.involvedObject.name : '',
      severity: CRITICAL_EVENT_REASONS.includes(e.reason) ? 'critical' : 'warning',
      type: 'Event',
      title: e.reason,
      detail: `${e.message}${total > 1 ? ` (occurred ${total}×)` : ''}`,
      restarts: 0,
      age: '',
      lastSeen: new Date(getEventTime(e)),
      containers: [],
    });
  });
  return out;
}

function timeAgo(d: Date): string {
  const mins = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h}h ${mins % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

// ─── sub-components ───────────────────────────────────────────────────────────

const SEVERITY_CONFIG = {
  critical: {
    border: 'border-red-500/40',
    badge: 'bg-red-500/10 text-red-400 border border-red-500/20',
    icon: XCircle,
    iconColor: 'text-red-400',
    dot: 'bg-red-500',
    accent: 'border-l-red-500',
  },
  warning: {
    border: 'border-yellow-500/30',
    badge: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',
    icon: AlertTriangle,
    iconColor: 'text-yellow-400',
    dot: 'bg-yellow-400',
    accent: 'border-l-yellow-400',
  },
  info: {
    border: 'border-blue-500/30',
    badge: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
    icon: Activity,
    iconColor: 'text-blue-400',
    dot: 'bg-blue-400',
    accent: 'border-l-blue-400',
  },
};

const TYPE_ICON: Record<Incident['type'], React.ElementType> = {
  CrashLoopBackOff: RotateCcw,
  ImagePullBackOff: Download,
  OOMKilled: Zap,
  Evicted: XCircle,
  Failed: XCircle,
  Pending: Hourglass,
  Restarted: RotateCcw,
  ContainerError: AlertTriangle,
  NodeNotReady: Server,
  NodePressure: Server,
  NodeCordoned: Server,
  Event: AlertTriangle,
};

function IncidentCard({
  incident,
  isDark,
  onAskAI,
}: {
  incident: Incident;
  isDark: boolean;
  onAskAI: (inc: Incident) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cfg = SEVERITY_CONFIG[incident.severity];
  const TypeIcon = TYPE_ICON[incident.type];
  const isPod = incident.kind === 'Pod';

  const label = isDark ? 'text-gray-500' : 'text-gray-400';
  const value = isDark ? 'text-gray-200' : 'text-gray-800';
  const fields: { name: string; val: string; mono?: boolean }[] = [
    { name: incident.kind, val: incident.name, mono: true },
    ...(isPod ? [{ name: 'Namespace', val: incident.namespace }] : []),
    ...(isPod && incident.node && incident.node !== '(unscheduled)' ? [{ name: 'Node', val: incident.node, mono: true }] : []),
    ...(isPod ? [{ name: 'Restarts', val: String(incident.restarts) }] : []),
    ...(incident.age ? [{ name: 'Age', val: incident.age }] : []),
  ];

  return (
    <div
      className={`rounded-xl border-l-4 border ${cfg.border} ${cfg.accent} ${
        isDark ? 'bg-[#0d1220]' : 'bg-white'
      } overflow-hidden transition-all`}
    >
      {/* Top row: severity + issue type + time */}
      <div className="flex items-center gap-2 flex-wrap px-4 pt-4">
        <TypeIcon size={18} className={cfg.iconColor} />
        <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded ${cfg.badge}`}>
          {incident.severity}
        </span>
        <span className={`text-sm font-semibold ${value}`}>
          {incident.type === 'Event' ? incident.title : incident.type}
        </span>
        <span className={`ml-auto flex items-center gap-1 text-xs ${label}`} title={incident.lastSeen.toLocaleString()}>
          <Clock size={11} />
          {timeAgo(incident.lastSeen)}
        </span>
      </div>

      <div className="px-4 pb-4 pt-3 space-y-3">
        {/* What happened */}
        <div>
          <p className={`text-[10px] font-semibold uppercase tracking-wide mb-0.5 ${label}`}>What happened</p>
          <p className={`text-sm leading-relaxed break-words ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            {incident.detail}
          </p>
        </div>

        {/* Labeled facts */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2">
          {fields.map(f => (
            <div key={f.name} className="min-w-0">
              <p className={`text-[10px] font-semibold uppercase tracking-wide ${label}`}>{f.name}</p>
              <p className={`text-xs truncate ${f.mono ? 'font-mono' : ''} ${value}`} title={f.val}>{f.val}</p>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={() => onAskAI(incident)}
            title="Open the AI chat to get the root cause analysis and solution steps"
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700 text-white shadow-sm transition-all"
          >
            <Bot size={16} />
            AI Chat — RCA &amp; Solution
          </button>
          {incident.containers.length > 0 && (
            <button
              onClick={() => setExpanded(e => !e)}
              className={`flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                isDark ? 'hover:bg-white/[0.06] text-gray-400' : 'hover:bg-gray-100 text-gray-500'
              }`}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded ? 'Hide containers' : 'Containers'}
            </button>
          )}
        </div>
      </div>

      {expanded && incident.containers.length > 0 && (
        <div className={`border-t px-4 py-3 ${isDark ? 'border-white/[0.06] bg-white/[0.02]' : 'border-gray-100 bg-gray-50'}`}>
          <p className={`text-xs font-semibold mb-2 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            CONTAINERS
          </p>
          <div className="space-y-2">
            {incident.containers.map(c => {
              const waiting = c.state?.waiting as { reason?: string } | undefined;
              const terminated = c.state?.terminated as { reason?: string; exitCode?: number } | undefined;
              const lastTerminated = c.lastState?.terminated as { reason?: string; exitCode?: number; finishedAt?: string } | undefined;
              return (
                <div key={c.name} className={`rounded-lg p-2.5 ${isDark ? 'bg-white/[0.03]' : 'bg-white border border-gray-200'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.ready ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className={`text-xs font-mono font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>{c.name}</span>
                    <span className={`ml-auto text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      {c.restartCount} restart{c.restartCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {waiting?.reason && (
                    <p className={`text-xs ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>
                      Waiting: {waiting.reason}
                    </p>
                  )}
                  {terminated && (
                    <p className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                      Terminated: {terminated.reason} (exit {terminated.exitCode ?? '?'})
                    </p>
                  )}
                  {lastTerminated && (
                    <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      Last exit: {lastTerminated.reason} (code {lastTerminated.exitCode ?? '?'})
                      {lastTerminated.finishedAt ? ` at ${new Date(lastTerminated.finishedAt).toLocaleString()}` : ''}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function Incidents() {
  const { openChatWithMessage: onAskAI } = useLayoutContext();
  const { isDark } = useTheme();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning'>('all');
  const [kindFilter, setKindFilter] = useState<'all' | 'Pod' | 'Node'>('all');

  const fetchIncidents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pods, nodes, events] = await Promise.all([getPods(), getNodes(), getEvents()]);
      const now = Date.now();

      const podIncidents = pods
        .map(p => classifyPod(p, now))
        .filter((i): i is Incident => i !== null);
      const nodeIncidents = nodes.flatMap(n => classifyNode(n, now));

      // Objects already reported from live state — don't duplicate them from events
      const covered = new Set<string>();
      podIncidents.forEach(i => covered.add(`Pod/${i.namespace}/${i.name}`));
      nodeIncidents.forEach(i => covered.add(`Node/${i.name}`));
      const eventIncidents = classifyEvents(events, covered, now);

      const order = { critical: 0, warning: 1, info: 2 };
      const all = [...podIncidents, ...nodeIncidents, ...eventIncidents].sort(
        (a, b) => order[a.severity] - order[b.severity] || b.lastSeen.getTime() - a.lastSeen.getTime()
      );
      setIncidents(all);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch cluster data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchIncidents(); }, [fetchIncidents]);

  const handleAskAI = (inc: Incident) => {
    const msg =
      `Root cause analysis for this incident. Give the root cause and step-by-step solution.\n\n` +
      `${inc.kind}: ${inc.name}\n` +
      (inc.kind === 'Pod' ? `Namespace: ${inc.namespace}\nNode: ${inc.node}\n` : '') +
      `Issue: ${inc.type} — ${inc.title}\n` +
      `Detail: ${inc.detail}\n` +
      (inc.kind === 'Pod' ? `Restarts: ${inc.restarts}\n` : '') +
      `Last seen: ${inc.lastSeen.toLocaleString()}`;
    onAskAI(msg, {
      kind: inc.kind,
      name: inc.name,
      namespace: inc.kind === 'Pod' ? inc.namespace : undefined,
      title: inc.type === 'Event' ? inc.title : inc.type,
    });
  };

  const byKind = kindFilter === 'all' ? incidents : incidents.filter(i => i.kind === kindFilter);
  const filtered = filter === 'all' ? byKind : byKind.filter(i => i.severity === filter);
  const criticalCount = byKind.filter(i => i.severity === 'critical').length;
  const warningCount = byKind.filter(i => i.severity === 'warning').length;
  const podCount = incidents.filter(i => i.kind === 'Pod').length;
  const nodeCount = incidents.filter(i => i.kind === 'Node').length;

  const tabCls = (active: boolean) =>
    `px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
      active
        ? isDark ? 'bg-white/10 text-white' : 'bg-white text-gray-900 shadow-sm'
        : isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'
    }`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className={`text-xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Incidents
          </h1>
          <p className={`text-sm mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            Pod &amp; node issues from the last 24 hours — restarts, CrashLoopBackOff, ImagePullBackOff, OOMKilled, Evicted, NotReady &amp; more
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={fetchIncidents}
            disabled={loading}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isDark ? 'bg-white/[0.06] text-gray-300 hover:bg-white/10' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Total Incidents', value: byKind.length, color: isDark ? 'text-white' : 'text-gray-900' },
          { label: 'Critical', value: criticalCount, color: 'text-red-400' },
          { label: 'Warning', value: warningCount, color: 'text-yellow-400' },
          { label: 'Pods / Nodes', value: `${podCount} / ${nodeCount}`, color: 'text-blue-400' },
        ].map(card => (
          <div
            key={card.label}
            className={`rounded-xl p-4 border ${isDark ? 'bg-[#0d1220] border-white/[0.06]' : 'bg-white border-gray-200'}`}
          >
            <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{card.label}</p>
            <p className={`text-2xl font-bold mt-1 ${card.color}`}>{card.value}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className={`flex gap-1 p-1 rounded-lg w-fit ${isDark ? 'bg-white/[0.04]' : 'bg-gray-100'}`}>
          {(['all', 'critical', 'warning'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)} className={`${tabCls(filter === f)} capitalize`}>
              {f === 'all' ? `All (${byKind.length})` : f === 'critical' ? `Critical (${criticalCount})` : `Warning (${warningCount})`}
            </button>
          ))}
        </div>
        <div className={`flex gap-1 p-1 rounded-lg w-fit ${isDark ? 'bg-white/[0.04]' : 'bg-gray-100'}`}>
          {(['all', 'Pod', 'Node'] as const).map(k => (
            <button key={k} onClick={() => setKindFilter(k)} className={tabCls(kindFilter === k)}>
              {k === 'all' ? 'Pods & Nodes' : k === 'Pod' ? `Pods (${podCount})` : `Nodes (${nodeCount})`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw size={20} className="animate-spin text-blue-400 mr-2" />
          <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>Scanning cluster for incidents…</span>
        </div>
      ) : error ? (
        <div className={`rounded-xl border p-6 text-center ${isDark ? 'bg-red-500/5 border-red-500/20' : 'bg-red-50 border-red-200'}`}>
          <AlertTriangle size={20} className="text-red-400 mx-auto mb-2" />
          <p className={`text-sm font-medium ${isDark ? 'text-red-300' : 'text-red-700'}`}>{error}</p>
          <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            Make sure the backend is running and connected to the cluster.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className={`rounded-xl border p-10 text-center ${isDark ? 'bg-[#0d1220] border-white/[0.06]' : 'bg-white border-gray-200'}`}>
          <Activity size={24} className="text-green-400 mx-auto mb-3" />
          <p className={`text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            No incidents in the last 24 hours
          </p>
          <p className={`text-xs mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            Pods and nodes look healthy.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(inc => (
            <IncidentCard
              key={inc.id}
              incident={inc}
              isDark={isDark}
              onAskAI={handleAskAI}
            />
          ))}
        </div>
      )}
    </div>
  );
}
