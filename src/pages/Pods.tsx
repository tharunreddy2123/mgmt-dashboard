import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTheme } from '../context/ThemeContext';
import { getPods, getNamespaces, getDeployments, type OCPod, type OCDeployment } from '../lib/openshift-direct';
import { getPodAge, getPodHealthStatus } from '../lib/openshift-direct';
import { BACKEND_URL } from '../lib/api-client';
import {
  Search, Filter, Layers, Container, AlertTriangle, CheckCircle,
  XCircle, Clock, RefreshCw, X, FileText, Terminal, ChevronDown, Copy, Check, ClipboardPaste,
  Minus,
} from 'lucide-react';

// ─── types ────────────────────────────────────────────────────────────────────

type PanelMode = 'logs' | 'describe';

interface PodPanel {
  podName: string;
  namespace: string;
  mode: PanelMode;
  loading: boolean;
  content: string | null;
  error: string | null;
  /** container names from pod spec — populated when the panel is opened */
  containers: string[];
  /** how many tail lines were requested (logs only) */
  tailLines: number;
  /** user-pasted log content (used when token lacks pods/log permission) */
  pastedContent: string | null;
}

// ─── tiny copy-to-clipboard button ───────────────────────────────────────────

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  if (label) {
    return (
      <button
        onClick={copy}
        title="Copy all to clipboard"
        className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors flex-shrink-0 ${
          copied
            ? 'bg-emerald-500/20 text-emerald-400'
            : 'bg-white/[0.06] text-gray-400 hover:bg-white/10 hover:text-white'
        }`}
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? 'Copied!' : label}
      </button>
    );
  }
  return (
    <button
      onClick={copy}
      title="Copy to clipboard"
      className="ml-1.5 p-0.5 rounded text-gray-400 hover:text-white transition-colors flex-shrink-0"
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
    </button>
  );
}

// ─── component ────────────────────────────────────────────────────────────────

export default function Pods() {
  const { isDark } = useTheme();
  const [pods, setPods] = useState<OCPod[]>([]);
  const [deployments, setDeployments] = useState<OCDeployment[]>([]);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [nsFilter, setNsFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // panel state — one open panel at a time
  const [panel, setPanel] = useState<PodPanel | null>(null);
  // textarea value for the "paste logs" input inside the RBAC-denied panel
  const [pasteInput, setPasteInput] = useState('');
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [pd, ns, deps] = await Promise.all([getPods(), getNamespaces(), getDeployments()]);
      setPods(pd);
      setDeployments(deps);
      const nsFromPods = [...new Set(pd.map(p => p.metadata.namespace))];
      const nsFromApi  = ns.map(n => n.metadata.name);
      const allNs = [...new Set([...nsFromApi, ...nsFromPods])].sort();
      setNamespaces(allNs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  // ── action handlers ──────────────────────────────────────────────────────

  /** Fetch logs or describe for a pod and populate the panel */
  const fetchPanel = async (
    podName: string,
    namespace: string,
    mode: PanelMode,
    containers: string[],
    tailLines: number,
  ) => {
    setPanel(p => p ? { ...p, loading: true, content: null, error: null } : p);
    try {
      const action = mode === 'logs' ? 'logs' : 'describe';
      const firstContainer = containers[0];
      const res = await fetch(`${BACKEND_URL}/api/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          kind: 'Pod',
          name: podName,
          namespace,
          ...(mode === 'logs' && firstContainer ? { container: firstContainer } : {}),
          ...(mode === 'logs' ? { tail_lines: tailLines } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      if (data.success === false && data.result) {
        setPanel(p => p ? { ...p, loading: false, error: data.result } : p);
      } else {
        setPanel(p => p ? { ...p, loading: false, content: data.result || '(no output)' } : p);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setPanel(p => p ? { ...p, loading: false, error: msg } : p);
    }
  };

  const openPanel = async (pod: OCPod, mode: PanelMode) => {
    // toggle closed if same panel already open
    if (panel?.podName === pod.metadata.name && panel?.namespace === pod.metadata.namespace && panel?.mode === mode) {
      setPanel(null);
      return;
    }
    const podContainers = pod.spec.containers?.map(c => c.name) ?? [];
    const tailLines = 0;   // 0 = all lines (no cap)
    setPasteInput('');
    setPanel({ podName: pod.metadata.name, namespace: pod.metadata.namespace, mode, loading: true, content: null, error: null, containers: podContainers, tailLines, pastedContent: null });
    await fetchPanel(pod.metadata.name, pod.metadata.namespace, mode, podContainers, tailLines);
  };

  // ── helpers ──────────────────────────────────────────────────────────────

  const getPodStatus = (pod: OCPod): string => {
    const containerStatuses = pod.status.containerStatuses || [];
    if (containerStatuses.some(cs => { const w = cs.state as { waiting?: { reason: string } }; return w?.waiting?.reason === 'CrashLoopBackOff'; })) return 'CrashLoopBackOff';
    if (containerStatuses.some(cs => { const t = cs.state as { terminated?: { reason: string } }; return t?.terminated?.reason === 'OOMKilled'; })) return 'OOMKilled';
    if (containerStatuses.some(cs => { const w = cs.state as { waiting?: { reason: string } }; return w?.waiting?.reason === 'ImagePullBackOff'; })) return 'ImagePullBackOff';
    if (containerStatuses.some(cs => { const w = cs.state as { waiting?: { reason: string } }; return w?.waiting?.reason === 'ContainerCreating'; })) return 'ContainerCreating';
    return pod.status.phase;
  };

  const getRestartCount = (pod: OCPod): number =>
    pod.status.containerStatuses?.reduce((sum, cs) => sum + cs.restartCount, 0) || 0;

  // Deployments scaled to 0 — no pods exist for these, show them separately
  const zeroRepDeps = deployments.filter(d => {
    const desired = d.spec?.replicas ?? 0;
    const matchNs = nsFilter === 'all' || d.metadata.namespace === nsFilter;
    const matchSearch = d.metadata.name.toLowerCase().includes(search.toLowerCase());
    return desired === 0 && matchNs && matchSearch;
  });

  // Build a map: "namespace/controllerName" → replica count for the Replicas column
  const replicaMap = new Map<string, number>();
  for (const d of deployments) {
    replicaMap.set(`${d.metadata.namespace}/${d.metadata.name}`, d.spec?.replicas ?? 0);
  }

  /** Get the replica count for the deployment that owns this pod */
  const getPodReplicas = (pod: OCPod): number | null => {
    const owners = pod.metadata.ownerReferences ?? [];
    const rs = owners.find(o => o.kind === 'ReplicaSet');
    if (rs) {
      const parts = rs.name.split('-');
      if (parts.length >= 2 && /^[a-z0-9]{5,16}$/.test(parts[parts.length - 1])) {
        const depName = parts.slice(0, -1).join('-');
        const key = `${pod.metadata.namespace}/${depName}`;
        if (replicaMap.has(key)) return replicaMap.get(key)!;
      }
    }
    const dep = owners.find(o => o.kind === 'Deployment');
    if (dep) return replicaMap.get(`${pod.metadata.namespace}/${dep.name}`) ?? null;
    return null;
  };

  const filtered = pods.filter(p => {
    const matchNs     = nsFilter === 'all' || p.metadata.namespace === nsFilter;
    const matchSearch = p.metadata.name.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || getPodStatus(p) === statusFilter;
    return matchNs && matchSearch && matchStatus;
  });

  const activeFilters = (nsFilter !== 'all' ? 1 : 0) + (statusFilter !== 'all' ? 1 : 0) + (search ? 1 : 0);

  const statusIcon = (status: string) => {
    switch (status) {
      case 'Running':          return <CheckCircle   size={14} className="text-emerald-400" />;
      case 'CrashLoopBackOff': return <XCircle       size={14} className="text-red-400" />;
      case 'OOMKilled':        return <AlertTriangle size={14} className="text-red-400" />;
      case 'ImagePullBackOff': return <XCircle       size={14} className="text-orange-400" />;
      case 'Pending':          return <Clock         size={14} className="text-blue-400" />;
      case 'Succeeded':        return <CheckCircle   size={14} className="text-gray-400" />;
      default:                 return <Container     size={14} className="text-gray-400" />;
    }
  };

  const statusBg = (status: string) => {
    switch (status) {
      case 'Running':          return 'text-emerald-400 bg-emerald-400/10';
      case 'CrashLoopBackOff': return 'text-red-400 bg-red-400/10';
      case 'OOMKilled':        return 'text-red-400 bg-red-400/10';
      case 'ImagePullBackOff': return 'text-orange-400 bg-orange-400/10';
      case 'Pending':          return 'text-blue-400 bg-blue-400/10';
      case 'Succeeded':        return 'text-gray-400 bg-gray-400/10';
      default:                 return 'text-gray-400 bg-gray-400/10';
    }
  };

  const healthColor = (health: string) => {
    if (health === 'healthy') return 'text-emerald-400';
    if (health === 'warning') return 'text-yellow-400';
    return 'text-red-400';
  };

  const uniqueStatuses = [...new Set(pods.map(p => getPodStatus(p)))].sort();
  const nsPodCount     = (ns: string) => pods.filter(p => p.metadata.namespace === ns).length;
  const runningCount   = pods.filter(p => getPodStatus(p) === 'Running').length;
  const crashLoopCount = pods.filter(p => getPodStatus(p) === 'CrashLoopBackOff').length;
  const oomCount       = pods.filter(p => getPodStatus(p) === 'OOMKilled').length;
  const pendingCount   = pods.filter(p => getPodStatus(p) === 'Pending').length;
  const highRestartCount = pods.filter(p => getRestartCount(p) > 5).length;

  // ── loading / error screens ──────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw size={24} className="animate-spin text-blue-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className={`rounded-xl p-8 border max-w-md text-center ${isDark ? 'bg-[#0d1220] border-red-500/20' : 'bg-white border-red-200'}`}>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{error}</p>
          <button onClick={fetchData} className="mt-4 px-4 py-2 rounded-lg bg-blue-500 text-white text-sm">Retry</button>
        </div>
      </div>
    );
  }

  // ── render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Pod Monitoring</h1>
          <p className={`text-sm mt-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {pods.length} pods across {namespaces.length} namespace{namespaces.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button onClick={fetchData} className={`p-2 rounded-lg transition-colors ${isDark ? 'hover:bg-white/[0.06] text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}>
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {[
          { label: 'Total',        value: pods.length,      color: 'text-blue-400' },
          { label: 'Running',      value: runningCount,     color: 'text-emerald-400' },
          { label: 'CrashLoop',    value: crashLoopCount,   color: 'text-red-400' },
          { label: 'OOMKilled',    value: oomCount,         color: 'text-red-400' },
          { label: 'Pending',      value: pendingCount,     color: 'text-blue-400' },
          { label: 'High Restart', value: highRestartCount, color: 'text-yellow-400' },
        ].map((item, i) => (
          <motion.div key={i} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
            className={`rounded-xl p-3 border text-center ${isDark ? 'bg-[#0d1220] border-white/[0.06]' : 'bg-white border-gray-200 shadow-sm'}`}
          >
            <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{item.label}</p>
            <p className={`text-xl font-bold ${item.color}`}>{item.value}</p>
          </motion.div>
        ))}
      </div>

      {/* Filters */}
      <div className={`rounded-xl border p-4 ${isDark ? 'bg-[#0d1220] border-white/[0.06]' : 'bg-white border-gray-200 shadow-sm'}`}>
        <div className="flex flex-wrap items-center gap-3">

          {/* Search */}
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg flex-1 min-w-[180px] ${isDark ? 'bg-white/[0.04] border border-white/[0.06]' : 'bg-gray-50 border border-gray-200'}`}>
            <Search size={14} className={isDark ? 'text-gray-500' : 'text-gray-400'} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search pod name…"
              className={`bg-transparent text-sm outline-none flex-1 ${isDark ? 'text-white placeholder-gray-500' : 'text-gray-900 placeholder-gray-400'}`}
            />
            {search && (
              <button onClick={() => setSearch('')} className={isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}>
                <X size={12} />
              </button>
            )}
          </div>

          {/* Namespace filter */}
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${isDark ? 'bg-white/[0.04] border border-white/[0.06]' : 'bg-gray-50 border border-gray-200'}`}>
            <Layers size={14} className={nsFilter !== 'all' ? 'text-blue-400' : (isDark ? 'text-gray-500' : 'text-gray-400')} />
            <select
              value={nsFilter}
              onChange={e => setNsFilter(e.target.value)}
              className={`bg-transparent text-sm outline-none cursor-pointer ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
            >
              <option value="all">All Namespaces ({namespaces.length})</option>
              {namespaces.map(ns => (
                <option key={ns} value={ns}>{ns}  ({nsPodCount(ns)} pods)</option>
              ))}
            </select>
          </div>

          {/* Status filter */}
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${isDark ? 'bg-white/[0.04] border border-white/[0.06]' : 'bg-gray-50 border border-gray-200'}`}>
            <Filter size={14} className={statusFilter !== 'all' ? 'text-blue-400' : (isDark ? 'text-gray-500' : 'text-gray-400')} />
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className={`bg-transparent text-sm outline-none cursor-pointer ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
            >
              <option value="all">All Status</option>
              {uniqueStatuses.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          {/* Clear all filters */}
          {activeFilters > 0 && (
            <button
              onClick={() => { setSearch(''); setNsFilter('all'); setStatusFilter('all'); }}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${isDark ? 'bg-red-400/10 text-red-400 hover:bg-red-400/20' : 'bg-red-50 text-red-500 hover:bg-red-100'}`}
            >
              <X size={12} />
              Clear {activeFilters} filter{activeFilters > 1 ? 's' : ''}
            </button>
          )}
        </div>

        {/* Active filter chips + result count */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            Showing <span className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>{filtered.length}</span> of <span className="font-semibold">{pods.length}</span> pods
          </span>
          {nsFilter !== 'all' && (
            <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-blue-400/10 text-blue-400' : 'bg-blue-50 text-blue-600'}`}>
              <Layers size={10} /> {nsFilter}
              <button onClick={() => setNsFilter('all')} className="ml-0.5 hover:opacity-70"><X size={10} /></button>
            </span>
          )}
          {statusFilter !== 'all' && (
            <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-purple-400/10 text-purple-400' : 'bg-purple-50 text-purple-600'}`}>
              <Filter size={10} /> {statusFilter}
              <button onClick={() => setStatusFilter('all')} className="ml-0.5 hover:opacity-70"><X size={10} /></button>
            </span>
          )}
          {search && (
            <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${isDark ? 'bg-yellow-400/10 text-yellow-400' : 'bg-yellow-50 text-yellow-600'}`}>
              <Search size={10} /> "{search}"
              <button onClick={() => setSearch('')} className="ml-0.5 hover:opacity-70"><X size={10} /></button>
            </span>
          )}
        </div>
      </div>

      {/* Pod table */}
      <div className={`rounded-xl border overflow-hidden ${isDark ? 'bg-[#0d1220] border-white/[0.06]' : 'bg-white border-gray-200 shadow-sm'}`}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className={`border-b ${isDark ? 'border-white/[0.06]' : 'border-gray-200'}`}>
                {['Pod', 'Namespace', 'Status', 'Replicas', 'Restarts', 'Node', 'Age', 'Health', 'Actions'].map(h => (
                  <th key={h} className={`px-4 py-3 text-left text-xs font-medium ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>

              {/* zero-replica deployments (scaled down, no pods) */}
              {zeroRepDeps.map(dep => (
                <tr
                  key={`zero-${dep.metadata.uid}`}
                  className={`border-b ${isDark ? 'border-white/[0.03] bg-yellow-400/[0.03]' : 'border-gray-100 bg-yellow-50/60'}`}
                >
                  {/* Name */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Minus size={14} className="text-yellow-400 flex-shrink-0" />
                      <span className={`text-sm font-medium truncate max-w-[200px] ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {dep.metadata.name}
                      </span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isDark ? 'bg-yellow-400/10 text-yellow-400' : 'bg-yellow-100 text-yellow-700'}`}>
                        Deployment
                      </span>
                    </div>
                  </td>
                  {/* Namespace */}
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded ${isDark ? 'bg-white/[0.06] text-gray-300' : 'bg-gray-100 text-gray-600'}`}>
                      {dep.metadata.namespace}
                    </span>
                  </td>
                  {/* Status */}
                  <td className="px-4 py-3">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium text-yellow-400 bg-yellow-400/10">
                      Scaled Down
                    </span>
                  </td>
                  {/* Replicas */}
                  <td className="px-4 py-3">
                    <span className="text-sm font-bold text-yellow-400">0</span>
                  </td>
                  {/* Restarts */}
                  <td className="px-4 py-3"><span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-300'}`}>—</span></td>
                  {/* Node */}
                  <td className="px-4 py-3"><span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-300'}`}>—</span></td>
                  {/* Age */}
                  <td className="px-4 py-3">
                    <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                      {getPodAge(dep.metadata.creationTimestamp)}
                    </span>
                  </td>
                  {/* Health */}
                  <td className="px-4 py-3">
                    <span className="text-xs font-medium text-yellow-400">scaled-down</span>
                  </td>
                  {/* Actions (read-only view) */}
                  <td className="px-4 py-3"><span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-300'}`}>-</span></td>
                </tr>
              ))}

              {/* ── regular pod rows ── */}
              {filtered.slice(0, 100).map((pod, i) => {
                const status   = getPodStatus(pod);
                const restarts = getRestartCount(pod);
                const health   = getPodHealthStatus(pod);
                const age      = getPodAge(pod.metadata.creationTimestamp);
                const replicas = getPodReplicas(pod);
                const isActive = panel?.podName === pod.metadata.name && panel?.namespace === pod.metadata.namespace;

                return (
                  <>
                    {/* ── pod row ── */}
                    <motion.tr
                      key={pod.metadata.uid || i}
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.01 }}
                      className={`border-b transition-colors ${
                        isActive
                          ? (isDark ? 'bg-white/[0.04] border-white/[0.06]' : 'bg-blue-50/60 border-gray-200')
                          : (isDark ? 'border-white/[0.03] hover:bg-white/[0.02]' : 'border-gray-100 hover:bg-gray-50')
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {statusIcon(status)}
                          <span className={`text-sm font-medium truncate max-w-[200px] ${isDark ? 'text-white' : 'text-gray-900'}`}>{pod.metadata.name}</span>
                          {isActive && <ChevronDown size={12} className={isDark ? 'text-blue-400' : 'text-blue-500'} />}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded ${isDark ? 'bg-white/[0.06] text-gray-300' : 'bg-gray-100 text-gray-600'}`}>{pod.metadata.namespace}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBg(status)}`}>{status}</span>
                      </td>
                      {/* Replicas */}
                      <td className="px-4 py-3">
                        {replicas !== null
                          ? <span className={`text-sm font-medium ${replicas === 0 ? 'text-yellow-400' : 'text-gray-300'}`}>{replicas}</span>
                          : <span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-300'}`}>—</span>
                        }
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-sm font-medium ${restarts > 5 ? 'text-red-400' : restarts > 0 ? 'text-yellow-400' : 'text-emerald-400'}`}>{restarts}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{pod.spec.nodeName || '-'}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{age}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium capitalize ${healthColor(health)}`}>{health}</span>
                      </td>

                      {/* ── action buttons ── */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          {/* Describe */}
                          <button
                            onClick={() => openPanel(pod, 'describe')}
                            title="Describe pod"
                            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              isActive && panel?.mode === 'describe'
                                ? 'bg-violet-500 text-white'
                                : isDark
                                  ? 'bg-violet-500/10 text-violet-400 hover:bg-violet-500/20'
                                  : 'bg-violet-50 text-violet-600 hover:bg-violet-100'
                            }`}
                          >
                            <FileText size={11} />
                            Describe
                          </button>

                          {/* Logs */}
                          <button
                            onClick={() => openPanel(pod, 'logs')}
                            title="View pod logs"
                            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                              isActive && panel?.mode === 'logs'
                                ? 'bg-emerald-500 text-white'
                                : isDark
                                  ? 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                                  : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                            }`}
                          >
                            <Terminal size={11} />
                            Logs
                          </button>
                        </div>
                      </td>
                    </motion.tr>

                    {/* ── inline output panel ── */}
                    <AnimatePresence>
                      {isActive && (
                        <motion.tr
                          key={`panel-${pod.metadata.uid || i}`}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.15 }}
                        >
                          <td colSpan={8} className={`px-0 border-b ${isDark ? 'border-white/[0.06]' : 'border-gray-200'}`}>
                            <motion.div
                              initial={{ height: 0 }}
                              animate={{ height: 'auto' }}
                              exit={{ height: 0 }}
                              transition={{ duration: 0.2 }}
                              style={{ overflow: 'hidden' }}
                            >
                              <div className={`mx-4 my-3 rounded-xl border overflow-hidden ${isDark ? 'bg-[#060d1a] border-white/[0.08]' : 'bg-gray-950 border-gray-700'}`}>

                                {/* panel header */}
                                <div className={`flex items-center justify-between px-4 py-2.5 border-b ${isDark ? 'border-white/[0.06]' : 'border-gray-700'}`}>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {panel?.mode === 'logs'
                                      ? <Terminal size={13} className="text-emerald-400" />
                                      : <FileText  size={13} className="text-violet-400" />
                                    }
                                    <span className="text-xs font-semibold text-white">
                                      {panel?.mode === 'logs' ? 'Logs' : 'Describe'} — {pod.metadata.name}
                                    </span>
                                    <span className={`text-xs px-1.5 py-0.5 rounded ${isDark ? 'bg-white/[0.06] text-gray-400' : 'bg-gray-700 text-gray-300'}`}>
                                      {pod.metadata.namespace}
                                    </span>
                                    {/* line count badge */}
                                    {panel?.mode === 'logs' && !panel.loading && (() => {
                                      const raw = panel.content?.startsWith('[previous container logs]')
                                        ? panel.content.replace('[previous container logs]\n', '')
                                        : panel.content;
                                      const src = raw || panel.pastedContent;
                                      if (!src) return null;
                                      const count = src.split('\n').length;
                                      return (
                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-mono">
                                          {count} line{count !== 1 ? 's' : ''}
                                        </span>
                                      );
                                    })()}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {/* tail-lines selector — logs only */}
                                    {panel?.mode === 'logs' && (
                                      <select
                                        value={panel.tailLines}
                                        onChange={e => {
                                          const tl = Number(e.target.value);
                                          setPanel(p => p ? { ...p, tailLines: tl } : p);
                                          if (panel) fetchPanel(panel.podName, panel.namespace, 'logs', panel.containers, tl);
                                        }}
                                        className="bg-white/[0.06] border border-white/10 text-gray-300 text-[11px] rounded px-1.5 py-0.5 outline-none cursor-pointer"
                                        title="Number of log lines to fetch"
                                      >
                                        <option value={100}>Last 100 lines</option>
                                        <option value={500}>Last 500 lines</option>
                                        <option value={1000}>Last 1000 lines</option>
                                        <option value={0}>All lines</option>
                                      </select>
                                    )}
                                    {/* copy all logs button — content or pasted content */}
                                    {panel?.mode === 'logs' && !panel.loading && (() => {
                                      const raw = panel.content?.startsWith('[previous container logs]')
                                        ? panel.content.replace('[previous container logs]\n', '')
                                        : panel.content;
                                      const copyText = raw || panel.pastedContent;
                                      if (!copyText) return null;
                                      return <CopyBtn text={copyText} label="Copy all" />;
                                    })()}
                                    {/* copy all describe button */}
                                    {panel?.mode === 'describe' && panel?.content && !panel.loading && (
                                      <CopyBtn text={panel.content} label="Copy all" />
                                    )}
                                    <button
                                      onClick={() => setPanel(null)}
                                      className="text-gray-500 hover:text-gray-300 transition-colors"
                                    >
                                      <X size={14} />
                                    </button>
                                  </div>
                                </div>

                                {/* panel body */}
                                <div className="px-4 py-3 max-h-[70vh] overflow-y-auto">
                                  {panel?.loading && (
                                    <div className="flex items-center gap-2 text-gray-400 text-xs py-4">
                                      <RefreshCw size={13} className="animate-spin" />
                                      Loading {panel.mode}…
                                    </div>
                                  )}
                                  {panel?.error && (() => {
                                    const isRbac = panel.error.includes('pods/log') || panel.error.includes('To fix:') || panel.error.includes('not accessible');
                                    if (isRbac) {
                                      const ctrs = panel.containers.length > 0 ? panel.containers : ['<container>'];
                                      return (
                                        <div className="space-y-3 text-xs">
                                          {/* header */}
                                          <div className="flex items-center gap-1.5 text-yellow-400 font-semibold">
                                            <AlertTriangle size={13} />
                                            Logs not accessible — read permission denied on <code className="bg-white/10 px-1 rounded">pods/log</code> in <code className="bg-white/10 px-1 rounded">{panel.namespace}</code>
                                          </div>

                                          {/* oc login hint */}
                                          <p className="text-gray-400 leading-relaxed">
                                            The dashboard token does not have <code className="bg-white/10 px-1 rounded">get pods/log</code> in this shared namespace. Run the commands below in your terminal to stream logs directly:
                                          </p>

                                          {/* copyable oc log command per container */}
                                          <div className="space-y-1.5">
                                            {ctrs.map(ctr => {
                                              const tailArg = panel.tailLines > 0 ? ` --tail=${panel.tailLines}` : '';
                                              const cmd = `oc logs ${panel.podName} -n ${panel.namespace} -c ${ctr}${tailArg}`;
                                              return (
                                                <div key={ctr} className="flex items-center gap-2 bg-black/40 border border-white/10 rounded px-3 py-2">
                                                  <Terminal size={11} className="text-emerald-400 flex-shrink-0" />
                                                  <code className="flex-1 text-emerald-300 font-mono break-all">{cmd}</code>
                                                  <CopyBtn text={cmd} />
                                                </div>
                                              );
                                            })}
                                          </div>

                                          {/* follow flag tip */}
                                          <p className="text-gray-500">
                                            Add <code className="bg-white/10 px-1 rounded">-f</code> to follow live. Add <code className="bg-white/10 px-1 rounded">--previous</code> to see the last crashed container's output.
                                          </p>

                                          {/* RBAC grant hint */}
                                          <details className="group">
                                            <summary className="cursor-pointer text-gray-500 hover:text-gray-300 transition-colors list-none flex items-center gap-1">
                                              <span className="text-[10px] border border-white/10 rounded px-1.5 py-0.5">Need permanent access?</span>
                                            </summary>
                                            <div className="mt-2 bg-black/40 border border-white/10 rounded px-3 py-2 space-y-1.5">
                                              <p className="text-gray-400">Ask a cluster admin to run:</p>
                                              {(() => {
                                                const rbacCmd = `oc policy add-role-to-user view $(oc whoami) -n ${panel.namespace}`;
                                                return (
                                                  <div className="flex items-center gap-2">
                                                    <code className="flex-1 text-blue-300 font-mono break-all">{rbacCmd}</code>
                                                    <CopyBtn text={rbacCmd} />
                                                  </div>
                                                );
                                              })()}
                                            </div>
                                          </details>

                                          {/* ── paste-logs section ── */}
                                          <div className="border-t border-white/[0.06] pt-3 space-y-2">
                                            <p className="text-gray-400 flex items-center gap-1.5">
                                              <ClipboardPaste size={12} />
                                              Ran the command? Paste the output below to view it here:
                                            </p>
                                            <textarea
                                              value={pasteInput}
                                              onChange={e => setPasteInput(e.target.value)}
                                              placeholder="Paste log output here…"
                                              rows={5}
                                              className="w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-xs text-gray-200 font-mono outline-none resize-y placeholder-gray-600 focus:border-emerald-500/40"
                                            />
                                            <div className="flex items-center gap-2">
                                              <button
                                                disabled={!pasteInput.trim()}
                                                onClick={() => {
                                                  setPanel(p => p ? { ...p, pastedContent: pasteInput.trim(), error: null } : p);
                                                }}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-[11px] font-medium"
                                              >
                                                <Terminal size={11} />
                                                View logs
                                              </button>
                                              {panel.pastedContent && (
                                                <button
                                                  onClick={() => {
                                                    setPanel(p => p ? { ...p, pastedContent: null } : p);
                                                    setPasteInput('');
                                                  }}
                                                  className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
                                                >
                                                  Clear
                                                </button>
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    }
                                    return (
                                      <div className="flex items-start gap-2 text-red-400 text-xs py-2">
                                        <XCircle size={13} className="mt-0.5 flex-shrink-0" />
                                        <span>{panel.error}</span>
                                      </div>
                                    );
                                  })()}
                                  {/* pasted log content (shown after user pastes from terminal) */}
                                  {panel?.pastedContent && !panel.loading && (
                                    <>
                                      <div className="flex items-center justify-between mb-2 mt-1">
                                        <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-medium">
                                          <ClipboardPaste size={11} />
                                          Pasted log output — {panel.pastedContent.split('\n').length} lines
                                        </div>
                                        <CopyBtn text={panel.pastedContent} label="Copy all" />
                                      </div>
                                      <pre className="text-xs text-gray-200 font-mono leading-relaxed whitespace-pre-wrap break-words">
                                        {panel.pastedContent}
                                      </pre>
                                    </>
                                  )}
                                  {panel?.content && !panel.loading && (() => {
                                    const isPrevious = panel.content!.startsWith('[previous container logs]');
                                    const displayContent = isPrevious
                                      ? panel.content!.replace('[previous container logs]\n', '')
                                      : panel.content!;
                                    return (
                                      <>
                                        {isPrevious && (
                                          <div className="flex items-center gap-1.5 mb-2 text-yellow-400 text-xs font-medium">
                                            <AlertTriangle size={11} />
                                            Showing logs from previous (crashed) container
                                          </div>
                                        )}
                                        {displayContent === '(no output)' || displayContent.trim() === '' ? (
                                          <p className="text-xs text-gray-500 italic py-2">(no log output)</p>
                                        ) : (
                                          <pre className="text-xs text-gray-200 font-mono leading-relaxed whitespace-pre-wrap break-words">
                                            {displayContent}
                                          </pre>
                                        )}
                                      </>
                                    );
                                  })()}
                                </div>
                              </div>
                            </motion.div>
                          </td>
                        </motion.tr>
                      )}
                    </AnimatePresence>
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
