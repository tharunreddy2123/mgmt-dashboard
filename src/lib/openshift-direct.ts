// OpenShift API client — all calls go through the FastAPI backend (BACKEND_URL/api/openshift/*)

import { BACKEND_URL } from './api-client';

export interface OCNamespace {
  metadata: { name: string; uid: string; creationTimestamp: string; labels?: Record<string, string> };
  spec: { finalizers: string[] };
  status: { phase: string };
}

export interface OCPodContainer {
  name: string;
  image: string;
  resources?: { requests?: { cpu?: string; memory?: string }; limits?: { cpu?: string; memory?: string } };
}

export interface OCPodContainerStatus {
  name: string;
  restartCount: number;
  state: Record<string, unknown>;
  lastState?: Record<string, unknown>;
  ready: boolean;
  image: string;
}

export interface OCPod {
  metadata: {
    name: string;
    namespace: string;
    uid: string;
    creationTimestamp: string;
    ownerReferences?: Array<{ kind: string; name: string; uid: string }>;
  };
  spec: { nodeName?: string; containers: OCPodContainer[] };
  status: {
    phase: string;
    reason?: string;
    message?: string;
    startTime?: string;
    containerStatuses?: OCPodContainerStatus[];
  };
}

export interface OCNode {
  metadata: { name: string; uid: string; labels: Record<string, string>; creationTimestamp: string };
  spec?: { unschedulable?: boolean };
  status: { conditions: Array<{ type: string; status: string; reason: string; message: string; lastTransitionTime?: string }>; capacity: { cpu: string; memory: string; pods: string }; allocatable: { cpu: string; memory: string; pods: string } };
}

export interface OCDeployment {
  metadata: { name: string; namespace: string; uid: string; creationTimestamp: string };
  spec: { replicas: number; selector: Record<string, unknown>; template: Record<string, unknown> };
  status: { replicas: number; updatedReplicas: number; availableReplicas: number; readyReplicas: number; unavailableReplicas: number; conditions?: Array<{ type: string; status: string; reason: string; message: string; lastUpdateTime: string }> };
}

export interface OCEvent {
  metadata: { name: string; uid: string; creationTimestamp: string };
  involvedObject: { name: string; namespace: string; kind: string };
  reason: string;
  message: string;
  source: { component: string };
  type: string;
  count: number;
  lastTimestamp: string;
  eventTime?: string | null;
}

/** Best available timestamp for an event (newer events may have no lastTimestamp). */
export function getEventTime(e: OCEvent): string {
  return e.lastTimestamp || e.eventTime || e.metadata.creationTimestamp;
}

// -- Log scan (backend: /api/openshift/log-alerts) ----------------------------

export interface LogSample { ts: string; level: 'error' | 'warning'; message: string }

export interface LogFinding {
  namespace: string;
  pod: string;
  container: string;
  error_count: number;
  warning_count: number;
  samples: LogSample[];
}

export interface LogAlertsResponse {
  window_hours: number;
  containers_total: number;
  containers_scanned: number;
  inaccessible: number;
  findings: LogFinding[];
}

export async function getLogAlerts(): Promise<LogAlertsResponse> {
  return await fetchBackend('/api/openshift/log-alerts') as LogAlertsResponse;
}

// -- API functions (FastAPI backend: main.py /api/openshift/*) ----------------

export async function getNamespaces(): Promise<OCNamespace[]> {
  const data = await fetchBackend('/api/openshift/namespaces') as { namespaces?: OCNamespace[] };
  return data.namespaces || [];
}

export async function getPods(namespace?: string): Promise<OCPod[]> {
  const url = namespace ? `/api/openshift/pods?namespace=${namespace}` : '/api/openshift/pods';
  const data = await fetchBackend(url) as { pods?: OCPod[] };
  return data.pods || [];
}

export async function getNodes(): Promise<OCNode[]> {
  try {
    const data = await fetchBackend('/api/openshift/nodes') as { nodes?: OCNode[] };
    return data.nodes || [];
  } catch { return []; }
}

export async function getDeployments(namespace?: string): Promise<OCDeployment[]> {
  const url = namespace ? `/api/openshift/deployments?namespace=${namespace}` : '/api/openshift/deployments';
  const data = await fetchBackend(url) as { deployments?: OCDeployment[] };
  return data.deployments || [];
}

export async function getEvents(namespace?: string): Promise<OCEvent[]> {
  const url = namespace ? `/api/openshift/events?namespace=${namespace}` : '/api/openshift/events';
  const data = await fetchBackend(url) as { events?: OCEvent[] };
  return data.events || [];
}

export async function getPodLogs(namespace: string, podName: string, container?: string): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/api/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'logs', kind: 'Pod', name: podName, namespace, container }),
  });
  if (!res.ok) throw new Error(`Failed to fetch logs: ${res.status}`);
  const data = await res.json() as { result?: string };
  return data.result || '(no output)';
}

// ── helper: fetch from FastAPI backend (production path) ─────────────────────

async function fetchBackend(path: string): Promise<unknown> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = `Backend error: ${res.status}`;
    try {
      const parsed = JSON.parse(body);
      if (parsed.detail) msg = parsed.detail;
      else if (parsed.error) msg = parsed.error;
    } catch { /* use default */ }
    throw new Error(msg);
  }
  return res.json();
}

// ── utility functions (unchanged) ────────────────────────────────────────────

export function getPodAge(creationTimestamp: string): string {
  const created = new Date(creationTimestamp);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days > 0) return `${days}d`;
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor(diffMs / (1000 * 60));
  return `${minutes}m`;
}

export function getPodHealthStatus(pod: OCPod): 'healthy' | 'warning' | 'critical' {
  const containerStatuses = pod.status.containerStatuses || [];
  const hasCrashLoop = containerStatuses.some(cs => {
    const waiting = cs.state as { waiting?: { reason: string } };
    return waiting?.waiting?.reason === 'CrashLoopBackOff';
  });
  const hasOOM = containerStatuses.some(cs => {
    const terminated = cs.state as { terminated?: { reason: string } };
    return terminated?.terminated?.reason === 'OOMKilled';
  });
  const highRestarts = containerStatuses.some(cs => cs.restartCount > 5);
  if (hasCrashLoop || hasOOM || pod.status.phase === 'Failed') return 'critical';
  if (highRestarts || pod.status.phase === 'Pending') return 'warning';
  return 'healthy';
}

export function getNodeRole(node: OCNode): string {
  const labels = node.metadata.labels || {};
  if (labels['node-role.kubernetes.io/master'] !== undefined || labels['node-role.kubernetes.io/control-plane'] !== undefined) return 'master';
  return 'worker';
}

export function getNodeConditions(node: OCNode): Array<{ type: string; status: string }> {
  return (node.status.conditions || []).map(c => ({ type: c.type, status: c.status }));
}

export function isNodeReady(node: OCNode): boolean {
  return node.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True') || false;
}

// Made with Bob
