"""Root-cause investigation: gathers evidence for failing pods and the pods they depend on.

The result is a plain-text evidence bundle that is handed to the LLM together with
RCA_SYSTEM_INSTRUCTION. Nothing here calls the LLM.
"""
import asyncio
import re
from typing import Any, Dict, List, Optional, Set, Tuple

from openshift_client import openshift_client

_STRONG = re.compile(
    r"\b(root.?cause|rca|investigat\w*|diagnos\w*|troubleshoot\w*|what.?s wrong|what happened|not working)\b",
    re.I,
)
_WEAK = re.compile(r"\b(why|cause|reason|fix|issue|problem)\b", re.I)
_POD_INTENTS = {"pods", "events", "health", "deployments", "logs"}

_STOP = {
    "pod", "the", "why", "and", "for", "not", "get", "all", "any", "are", "has", "how", "its",
    "pods", "root", "cause", "what", "with", "this", "that", "from", "namespace", "deployment",
    "issue", "problem", "check", "logs", "error", "running", "failing", "crash", "restart",
    "restarting", "investigate", "analyze", "analyse", "diagnose", "please", "again", "other",
    "events", "cluster", "health", "status",
}

_NO_LOG_WAITING = {"ImagePullBackOff", "ErrImagePull", "ContainerCreating", "PodInitializing",
                   "CreateContainerConfigError", "InvalidImageName"}

MAX_PRIMARY = 3
MAX_DEPENDENCY_PODS = 3
LOG_TAIL = 60
LOG_CHARS = 2500
TOTAL_CHARS = 16000


def is_rca_question(message: str, intents: Set[str]) -> bool:
    if _STRONG.search(message):
        return True
    return bool(_WEAK.search(message)) and bool(intents & _POD_INTENTS)


# ── helpers ──────────────────────────────────────────────────────────────────

def _meta(p: Dict) -> Tuple[str, str]:
    m = p.get("metadata", {})
    return m.get("namespace", "?"), m.get("name", "?")


def _all_statuses(pod: Dict) -> List[Tuple[Dict, bool]]:
    st = pod.get("status", {})
    return ([(c, True) for c in st.get("initContainerStatuses", [])] +
            [(c, False) for c in st.get("containerStatuses", [])])


def _container_problem(cs: Dict) -> Optional[str]:
    state = cs.get("state", {})
    w = state.get("waiting")
    if w and w.get("reason") not in (None, "PodInitializing", "ContainerCreating"):
        return w["reason"]
    t = state.get("terminated")
    if t and t.get("exitCode", 0) != 0:
        return t.get("reason") or f"exit {t.get('exitCode')}"
    lt = cs.get("lastState", {}).get("terminated")
    if lt and lt.get("exitCode", 0) != 0 and cs.get("restartCount", 0) > 0:
        return f"previously {lt.get('reason') or 'exit ' + str(lt.get('exitCode'))}"
    return None


def _severity(pod: Dict) -> int:
    status = pod.get("status", {})
    phase = status.get("phase")
    if phase == "Succeeded":
        return 0
    score = 0
    if phase in ("Failed", "Unknown"):
        score += 100
    if phase == "Pending":
        score += 60
    if pod.get("metadata", {}).get("deletionTimestamp"):
        score += 30
    for cs, _ in _all_statuses(pod):
        if _container_problem(cs):
            score += 50
        elif phase == "Running" and not cs.get("ready", True):
            score += 20
        if cs.get("restartCount", 0) > 2:
            score += min(cs["restartCount"], 20)
    return score


def _owner(pod: Dict) -> str:
    refs = pod.get("metadata", {}).get("ownerReferences") or []
    return f"{refs[0].get('kind')}/{refs[0].get('name')}" if refs else "none"


def _pod_line(pod: Dict) -> str:
    ns, name = _meta(pod)
    st = pod.get("status", {})
    probs = [p for p in (_container_problem(cs) for cs, _ in _all_statuses(pod)) if p]
    restarts = sum(cs.get("restartCount", 0) for cs, _ in _all_statuses(pod))
    return (f"  {ns}/{name} phase={st.get('phase')} node={pod.get('spec', {}).get('nodeName', '-')} "
            f"restarts={restarts} owner={_owner(pod)}" + (f" problems={probs}" if probs else ""))


def _boundary(word: str) -> str:
    return rf"(?<![\w.-]){re.escape(word)}(?![\w-])"


def _match_targets(text: str, pods: List[Dict]) -> List[Dict]:
    text = text.lower()
    exact = [p for p in pods if re.search(_boundary(_meta(p)[1].lower()), text)]
    if exact:
        return exact
    tokens = {t for t in re.findall(r"[a-z0-9][a-z0-9.\-]{2,}", text) if t not in _STOP}
    return [p for p in pods if any(_meta(p)[1].lower().startswith(t + "-") for t in tokens)]


# ── evidence collection ──────────────────────────────────────────────────────

async def _pod_logs(ns: str, pod: str, container: str, previous: bool) -> Tuple[Optional[str], Optional[str]]:
    params = [f"tailLines={LOG_TAIL}", f"container={container}"] + (["previous=true"] if previous else [])
    text = await openshift_client._api_request_text(
        f"/api/v1/namespaces/{ns}/pods/{pod}/log?{'&'.join(params)}", timeout=30)
    if text.startswith("Error"):
        return None, text.splitlines()[0][:200]
    text = text.strip()
    if not text:
        return None, "empty"
    return text[-LOG_CHARS:], None


async def _pod_events(ns: str, pod: str) -> List[Dict]:
    data = await openshift_client._api_request(
        f"/api/v1/namespaces/{ns}/events?fieldSelector=involvedObject.name={pod}")
    items = data.get("items", [])
    items.sort(key=lambda e: e.get("lastTimestamp") or e.get("eventTime") or "")
    return items[-10:]


def _fmt_container(cs: Dict, spec: Dict, init: bool) -> List[str]:
    state = cs.get("state", {})
    if "waiting" in state:
        w = state["waiting"]
        s = f"Waiting reason={w.get('reason')} message={(w.get('message') or '')[:300]!r}"
    elif "terminated" in state:
        t = state["terminated"]
        s = (f"Terminated reason={t.get('reason')} exitCode={t.get('exitCode')} "
             f"finishedAt={t.get('finishedAt')} message={(t.get('message') or '')[:200]!r}")
    elif "running" in state:
        s = f"Running since {state['running'].get('startedAt')}"
    else:
        s = "Unknown"
    out = [f"  {'init-container' if init else 'container'} {cs.get('name')}: image={cs.get('image')} "
           f"ready={cs.get('ready')} restarts={cs.get('restartCount', 0)} state: {s}"]
    lt = cs.get("lastState", {}).get("terminated")
    if lt:
        out.append(f"    lastState: Terminated reason={lt.get('reason')} exitCode={lt.get('exitCode')} "
                   f"finishedAt={lt.get('finishedAt')} message={(lt.get('message') or '')[:200]!r}")
    res = spec.get("resources", {})
    if res:
        out.append(f"    resources: requests={res.get('requests', {})} limits={res.get('limits', {})}")
    for probe in ("readinessProbe", "livenessProbe", "startupProbe"):
        if spec.get(probe):
            out.append(f"    {probe}: {spec[probe]}")
    return out


async def _pod_evidence(pod: Dict, deep: bool) -> Tuple[str, str]:
    """Return (evidence text, raw text used later for dependency scanning)."""
    ns, name = _meta(pod)
    spec = pod.get("spec", {})
    status = pod.get("status", {})
    lines = [
        f"=== POD {ns}/{name} ===",
        f"phase={status.get('phase')} node={spec.get('nodeName', '-')} owner={_owner(pod)} "
        f"created={pod.get('metadata', {}).get('creationTimestamp')} "
        f"deleting={bool(pod.get('metadata', {}).get('deletionTimestamp'))}",
        f"labels={pod.get('metadata', {}).get('labels', {})}",
    ]
    bad_conditions = [c for c in status.get("conditions", []) if c.get("status") != "True"]
    for c in bad_conditions:
        lines.append(f"condition {c.get('type')}={c.get('status')} reason={c.get('reason')} "
                     f"message={(c.get('message') or '')[:300]!r}")

    specs = {c["name"]: c for c in spec.get("containers", []) + spec.get("initContainers", [])}
    log_targets: List[Tuple[str, Dict]] = []
    for cs, init in _all_statuses(pod):
        lines.extend(_fmt_container(cs, specs.get(cs.get("name"), {}), init))
        if _container_problem(cs) or not cs.get("ready", True):
            log_targets.append((cs["name"], cs))
    if not log_targets:
        log_targets = [(cs["name"], cs) for cs, _ in _all_statuses(pod)][:2]

    events = await _pod_events(ns, name)
    raw = []
    if events:
        lines.append("events (oldest -> newest):")
        for e in events:
            msg = (e.get("message") or "")[:300]
            raw.append(msg)
            lines.append(f"  [{e.get('type')}] {e.get('reason')} x{e.get('count', 1)} "
                         f"last={e.get('lastTimestamp') or e.get('eventTime')}: {msg}")
    else:
        lines.append("events: none recorded")

    tail = LOG_CHARS if deep else 800
    for cname, cs in log_targets[:2]:
        state = cs.get("state", {})
        waiting_reason = state.get("waiting", {}).get("reason")
        can_current = ("running" in state or "terminated" in state)
        if waiting_reason in _NO_LOG_WAITING and cs.get("restartCount", 0) == 0:
            can_current = False
        if can_current:
            text, err = await _pod_logs(ns, name, cname, previous=False)
            lines.append(f"logs[{cname}] current (last {LOG_TAIL} lines):" if text
                         else f"logs[{cname}] current unavailable: {err}")
            if text:
                lines.append(text[-tail:])
                raw.append(text)
        if cs.get("restartCount", 0) > 0:
            text, err = await _pod_logs(ns, name, cname, previous=True)
            lines.append(f"logs[{cname}] PREVIOUS crashed instance (last {LOG_TAIL} lines):" if text
                         else f"logs[{cname}] previous unavailable: {err}")
            if text:
                lines.append(text[-tail:])
                raw.append(text)
    return "\n".join(lines), "\n".join(raw).lower()


async def _node_evidence(node: str, pods: List[Dict]) -> str:
    data = await openshift_client._api_request(f"/api/v1/nodes/{node}")
    on_node = [p for p in pods if p.get("spec", {}).get("nodeName") == node]
    unhealthy = sum(1 for p in on_node if _severity(p) > 0)
    head = f"=== NODE {node} === pods_on_node={len(on_node)} unhealthy_pods_on_node={unhealthy}"
    if data.get("error"):
        return f"{head}\nnode details not accessible: {str(data['error'])[:150]}"
    conds = data.get("status", {}).get("conditions", [])
    bad = [f"{c['type']}={c['status']} ({c.get('reason')}: {(c.get('message') or '')[:150]})"
           for c in conds
           if (c.get("type") == "Ready" and c.get("status") != "True")
           or (c.get("type") != "Ready" and c.get("status") == "True")]
    alloc = data.get("status", {}).get("allocatable", {})
    return f"{head}\nallocatable cpu={alloc.get('cpu')} memory={alloc.get('memory')}\n" + \
        ("abnormal conditions: " + "; ".join(bad) if bad else "all node conditions normal")


async def _services(ns: str, cache: Dict[str, List[Dict]]) -> List[Dict]:
    if ns not in cache:
        cache[ns] = (await openshift_client._api_request(f"/api/v1/namespaces/{ns}/services")).get("items", [])
    return cache[ns]


async def _find_dependencies(ns: str, scan_text: str, own_labels: Dict[str, str],
                             cache: Dict[str, List[Dict]]) -> List[Tuple[str, Dict]]:
    found: Dict[Tuple[str, str], Tuple[str, Dict]] = {}
    for svc in await _services(ns, cache):
        sname = svc["metadata"]["name"]
        if sname in ("kubernetes", "openshift") or len(sname) < 2:
            continue
        if not re.search(_boundary(sname.lower()), scan_text):
            continue
        sel = svc.get("spec", {}).get("selector") or {}
        if sel and all(own_labels.get(k) == v for k, v in sel.items()):
            continue  # the pod's own service
        found[(ns, sname)] = (ns, svc)
    for m in re.finditer(r"([a-z0-9-]+)\.([a-z0-9-]+)\.svc", scan_text):
        sname, sns = m.groups()
        if sns == ns:
            continue
        for svc in await _services(sns, cache):
            if svc["metadata"]["name"] == sname:
                found[(sns, sname)] = (sns, svc)
    return list(found.values())[:4]


def _service_summary(ns: str, svc: Dict, pods: List[Dict]) -> Tuple[str, List[Dict]]:
    sname = svc["metadata"]["name"]
    sel = svc.get("spec", {}).get("selector") or {}
    backing = [p for p in pods if _meta(p)[0] == ns and sel and
               all(p.get("metadata", {}).get("labels", {}).get(k) == v for k, v in sel.items())]
    lines = [f"=== DEPENDENCY service {ns}/{sname} (referenced in logs/events) === "
             f"selector={sel or 'none'} ports={[p.get('port') for p in svc.get('spec', {}).get('ports', [])]}"]
    if not sel:
        lines.append("  service has no selector (external or manually managed endpoints)")
    elif not backing:
        lines.append("  NO pods match this service selector -> service has no endpoints")
    for p in backing:
        lines.append(_pod_line(p))
    return "\n".join(lines), backing


# ── public entry points ──────────────────────────────────────────────────────

async def investigate_node(node: str) -> Optional[str]:
    """Collect evidence for a node incident: conditions, events and the pods running on it."""
    pods = await openshift_client.get_pods()
    sections = [await _node_evidence(node, pods)]

    ev = await openshift_client._api_request(
        f"/api/v1/namespaces/default/events?fieldSelector=involvedObject.name={node}")
    items = ev.get("items", [])
    items.sort(key=lambda e: e.get("lastTimestamp") or e.get("eventTime") or "")
    if items:
        lines = ["node events (oldest -> newest):"]
        for e in items[-10:]:
            lines.append(f"  [{e.get('type')}] {e.get('reason')} x{e.get('count', 1)} "
                         f"last={e.get('lastTimestamp') or e.get('eventTime')}: {(e.get('message') or '')[:300]}")
        sections.append("\n".join(lines))

    on_node = sorted((p for p in pods if p.get("spec", {}).get("nodeName") == node),
                     key=_severity, reverse=True)
    if on_node:
        sections.append(f"=== PODS ON NODE {node} (most unhealthy first) ===\n" +
                        "\n".join(_pod_line(p) for p in on_node[:15]))
    return ("INVESTIGATION SCOPE: node = " + node + "\n\n" + "\n\n".join(sections))[:TOTAL_CHARS]


async def investigate(message: str, history_text: str = "",
                      force: Optional[Tuple[str, str]] = None) -> Optional[str]:
    """Collect evidence for the pod(s) the question is about. Returns None if nothing to investigate."""
    pods = await openshift_client.get_pods()
    if not pods:
        return None

    if force:
        primaries = [p for p in pods if _meta(p) == force]
    else:
        primaries = _match_targets(message, pods) or (_match_targets(history_text, pods) if history_text else [])
        namespaces = {_meta(p)[0] for p in pods}
        mentioned = {ns for ns in namespaces if re.search(_boundary(ns.lower()), message.lower())}
        explicit = bool(primaries)
        if not primaries:
            primaries = [p for p in pods if _severity(p) > 0 and (not mentioned or _meta(p)[0] in mentioned)]
        primaries.sort(key=_severity, reverse=True)
        if not explicit:  # auto-picked: one pod per controller is enough
            seen: Set[Tuple[str, str]] = set()
            unique = []
            for p in primaries:
                key = (_meta(p)[0], _owner(p))
                if key not in seen:
                    seen.add(key)
                    unique.append(p)
            primaries = unique
    primaries = primaries[:MAX_PRIMARY]
    if not primaries:
        return None

    results = await asyncio.gather(*[_pod_evidence(p, deep=True) for p in primaries])
    sections = [t for t, _ in results]
    examined = {_meta(p) for p in primaries}

    # Node health for the primary pods
    for node in sorted({p.get("spec", {}).get("nodeName") for p in primaries} - {None}):
        sections.append(await _node_evidence(node, pods))

    # Other unhealthy pods in the same namespace(s) + sibling replicas
    pri_ns = {_meta(p)[0] for p in primaries}
    pri_owner = {(_meta(p)[0], _owner(p)) for p in primaries}
    siblings = [p for p in pods if _meta(p) not in examined and _meta(p)[0] in pri_ns and
                ((_meta(p)[0], _owner(p)) in pri_owner or _severity(p) > 0)]
    if siblings:
        sections.append("=== OTHER PODS IN THE SAME NAMESPACE(S) (replicas / unhealthy) ===\n" +
                        "\n".join(_pod_line(p) for p in siblings[:10]))

    # Dependencies referenced in logs/events -> check the pods behind them
    cache: Dict[str, List[Dict]] = {}
    dep_pods_checked = 0
    for pod, (_, raw) in zip(primaries, results):
        ns = _meta(pod)[0]
        own_labels = pod.get("metadata", {}).get("labels", {}) or {}
        for dns, svc in await _find_dependencies(ns, raw, own_labels, cache):
            summary, backing = _service_summary(dns, svc, pods)
            sections.append(summary)
            for bp in sorted(backing, key=_severity, reverse=True):
                if _severity(bp) > 0 and _meta(bp) not in examined and dep_pods_checked < MAX_DEPENDENCY_PODS:
                    examined.add(_meta(bp))
                    dep_pods_checked += 1
                    sections.append((await _pod_evidence(bp, deep=False))[0])

    header = ("INVESTIGATION SCOPE: primary pods = " + ", ".join(f"{n}/{m}" for n, m in sorted(
        _meta(p) for p in primaries)) + f"; total pods examined = {len(examined)}; "
        f"dependency pods checked = {dep_pods_checked}")
    out = header + "\n\n" + "\n\n".join(sections)
    return out[:TOTAL_CHARS]
