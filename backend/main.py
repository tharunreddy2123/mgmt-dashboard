from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel
from typing import List, Optional, Dict, Any, Tuple
import re
import json
import httpx
import uvicorn

from config import settings
from rca import is_rca_question, investigate, investigate_node
from openshift_client import openshift_client
from watsonx_client import watsonx_client
from ica_client import ica_client

app = FastAPI(title="OpenShift AI Assistant API", version="3.0.0")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins_list,
                   allow_credentials=True, allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=1000)

class ChatMessage(BaseModel):
    role: str
    content: str

class IncidentRef(BaseModel):
    kind: str                      # "Pod" or "Node"
    name: str
    namespace: Optional[str] = None

class ChatRequest(BaseModel):
    message: str
    conversation_history: Optional[List[ChatMessage]] = None
    include_context: bool = True
    incident: Optional[IncidentRef] = None   # set when the chat is opened from an Incidents card

class ChatResponse(BaseModel):
    response: str
    action_performed: Optional[str] = None
    action_success: Optional[bool] = None
    context_used: Optional[str] = None

class AnalyzeLogsRequest(BaseModel):
    namespace: str
    pod_name: str

class ClusterHealthResponse(BaseModel):
    health_data: Dict[str, Any]
    ai_analysis: str

class ActionRequest(BaseModel):
    action: str
    kind: str
    name: Optional[str] = None
    namespace: Optional[str] = None
    container: Optional[str] = None
    tail_lines: Optional[int] = 0

_DEFAULT_NAMESPACE = "tharunreddy-dev"

# ──────────────────────────────────────────────────────────────────────────────
# READ-ONLY ENFORCEMENT
# This application NEVER issues any write, patch, delete, exec, or scale
# operation against the cluster. Every request that reaches the OpenShift API
# is a plain HTTP GET. The guards below are defence-in-depth for the LLM layer.
# ──────────────────────────────────────────────────────────────────────────────

# Only these two actions (both are GET-only) are ever allowed.
_READ_ONLY_ACTIONS: frozenset = frozenset({"logs", "describe"})

_READ_ONLY_REPLY = (
    "🔒 **This assistant is read-only.**\n\n"
    "I can view pods, logs, events, nodes, deployments and namespaces, "
    "and I can explain issues and recommend fix commands — "
    "but I **cannot** create, delete, scale, restart, patch, exec into, "
    "or modify anything in the cluster.\n\n"
    "To apply a change, run the suggested `oc` command yourself with an "
    "account that has write access."
)

# Requests that try to change the cluster — checked BEFORE any LLM call.
# Verbs: every kubectl/oc mutating verb.
# Resources: extended to cover all common Kubernetes/OpenShift resource types.
_WRITE_REQUEST = re.compile(
    r"\b("
    r"create|make|spin.?up|launch|new|add|"
    r"delete|remove|destroy|kill|terminate|"
    r"scale|resize|set\s+replicas?|"
    r"restart|reboot|bounce|rollout\s+restart|redeploy|"
    r"patch|edit|update|apply|replace|"
    r"rollback|undo|"
    r"exec|rsh|run\s+in|attach|"
    r"evict|drain|cordon|uncordon|taint|"
    r"expose|port.?forward|cp\s|copy\s"
    r")\b"
    r".{0,80}"
    r"\b("
    r"pod|pods|container|containers|"
    r"deployment|deployments|statefulset|daemonset|replicaset|"
    r"service|svc|route|ingress|"
    r"configmap|cm|secret|"
    r"namespace|project|ns|"
    r"node|nodes|"
    r"replica|replicas|"
    r"job|cronjob|cron.?job|"
    r"pvc|persistentvolumeclaim|persistentvolume|pv|"
    r"serviceaccount|sa|role|rolebinding|clusterrole|"
    r"nginx|httpd|redis|mysql|postgres|python|busybox|alpine|ubuntu"
    r")\b",
    re.I,
)

def _is_write_request(message: str, generated: bool = False) -> bool:
    # generated=True: message was built by the UI from cluster data (Incidents -> AI chat); event text such as
    # 'Failed to create pod sandbox' would otherwise trip the keyword filter. Real enforcement is the GET-only
    # transport in openshift_client.py, this filter is just a UX guard.
    return (not generated) and bool(_WRITE_REQUEST.search(message))

_INTENT_PATTERNS = {
    "pods":        r"\b(pod|pods|container|crashloop|oom|evicted|terminating|pending|running|failed|restart)\b",
    "nodes":       r"\b(node|nodes|worker|master|control.?plane|notready|unschedulable)\b",
    "deployments": r"\b(deploy|deployment|deployments|rollout|replica|replicaset|scale)\b",
    "events":      r"\b(event|events|warning|error|reason|backoff|unhealthy)\b",
    "namespaces":  r"\b(namespace|namespaces|project|projects|ns)\b",
    "logs":        r"\b(log|logs|output|stdout|stderr)\b",
    "health":      r"\b(health|healthy|unhealthy|cluster.?health|status|overview|summary)\b",
    "list":        r"\b(list|show|get|display|all)\b",
    "services":    r"\b(service|services|svc|endpoint|port)\b",
    "describe":    r"\b(describe|inspect|detail|info|check)\b",
}

def _detect_intents(message: str) -> set:
    found = set()
    for intent, pattern in _INTENT_PATTERNS.items():
        if re.search(pattern, message, re.IGNORECASE):
            found.add(intent)
    return found

def _ns_from(text: str) -> str:
    m = re.search(r"\b(?:in|namespace|ns|project|on)\s+([\w-]+)", text, re.I)
    return m.group(1) if m else _DEFAULT_NAMESPACE

def _parse_action(msg: str) -> Optional[Dict[str, Any]]:
    """Map a chat message to a READ-ONLY action (describe / logs). Never returns a write action."""
    t = msg.strip()

    m = re.search(r"\b(describe|inspect|detail|info)\b.{0,30}\bpod\b.{0,30}\b([\w-]+)\b", t, re.I)
    if m:
        return {"action": "describe", "kind": "Pod", "name": m.group(2), "namespace": _ns_from(t)}

    m = re.search(r"\b(?:log|logs)\b.{0,30}\b(?:of|for|from)?\s*([\w-]+)\b(?:.{0,30}\b(?:in|ns)\s+([\w-]+))?", t, re.I)
    if m and m.group(1).lower() not in ("pod", "pods", "the", "a", "an", "all"):
        ns = m.group(2) if m.group(2) else _DEFAULT_NAMESPACE
        return {"action": "logs", "kind": "Pod", "name": m.group(1), "namespace": ns}

    return None

async def _execute_action(act: Dict[str, Any]) -> Tuple[str, bool]:
    action    = act["action"]
    kind      = act.get("kind", "")
    name      = act.get("name", "")
    ns        = act.get("namespace", _DEFAULT_NAMESPACE)
    container = act.get("container")
    if action not in _READ_ONLY_ACTIONS:
        return ("Action not permitted: this application is read-only.", False)
    try:
        if action == "describe":
            result = await openshift_client.describe_pod(ns, name)
            return (result, True)
        elif action == "logs":
            # tail_lines=0 means no limit (fetch all logs)
            tail_lines_val = act.get("tail_lines")
            tail = tail_lines_val if tail_lines_val is not None else 0
            result = await openshift_client.get_pod_logs(ns, name, tail_lines=tail, container=container)
            if result.startswith("Error"):
                return (result, False)
            return (result or "(no log output)", True)
    except Exception as e:
        return (f"Error executing {action} {kind} `{name}`: {str(e)}", False)
    return ("Unknown action.", False)

def _fmt_pod(p: Dict) -> str:
    meta = p.get("metadata", {})
    status = p.get("status", {})
    phase = status.get("phase", "Unknown")
    restarts = sum(cs.get("restartCount", 0) for cs in status.get("containerStatuses", []))
    containers = ", ".join(cs.get("name", "?") + ("(ready)" if cs.get("ready") else "(not-ready)") for cs in status.get("containerStatuses", []))
    return f"  pod {meta.get('namespace','?')}/{meta.get('name','?')}  phase={phase}  node={p.get('spec',{}).get('nodeName','?')}  restarts={restarts}  containers=[{containers}]"

def _fmt_deployment(d: Dict) -> str:
    meta = d.get("metadata", {}); spec = d.get("spec", {}); status = d.get("status", {})
    cs = spec.get("template", {}).get("spec", {}).get("containers", [])
    image = cs[0].get("image", "") if cs else ""
    return f"  deploy {meta.get('namespace','?')}/{meta.get('name','?')}  desired={spec.get('replicas',0)}  ready={status.get('readyReplicas',0)}  image={image}"

def _fmt_event(e: Dict) -> str:
    obj = e.get("involvedObject", {})
    return f"  [{e.get('type','?')}] {e.get('reason','?')} on {obj.get('kind','?')}/{obj.get('name','?')} ({obj.get('namespace','?')}): {e.get('message','')[:120]}"

async def _build_cluster_context(intents: set) -> str:
    sections: List[str] = []
    if intents & {"namespaces","pods","deployments","events","health","list","services","logs"}:
        try:
            nss = await openshift_client.get_namespaces()
            # If empty, probe directly to detect token expiry vs genuinely empty cluster
            if not nss:
                probe = await openshift_client._api_request("/apis/project.openshift.io/v1/projects")
                err = probe.get("error", "")
                if "401" in str(err):
                    return "TOKEN_EXPIRED"
            names = [n.get("metadata",{}).get("name","?") for n in nss]
            sections.append(f"ACCESSIBLE NAMESPACES ({len(names)}): {', '.join(names) if names else 'none'}")
        except Exception as ex:
            sections.append(f"NAMESPACES: error - {ex}")
    if intents & {"pods","health","logs","list","describe"}:
        try:
            pods = await openshift_client.get_pods()
            running = sum(1 for p in pods if p.get("status",{}).get("phase") == "Running")
            failed  = sum(1 for p in pods if p.get("status",{}).get("phase") == "Failed")
            pending = sum(1 for p in pods if p.get("status",{}).get("phase") == "Pending")
            high_r  = sum(1 for p in pods if sum(cs.get("restartCount",0) for cs in p.get("status",{}).get("containerStatuses",[])) > 2)
            lines = [f"LIVE PODS (total={len(pods)} running={running} failed={failed} pending={pending} high-restarts={high_r}):"]
            # Cap at 20 pods to keep prompt size manageable for watsonx
            for p in pods[:20]:
                lines.append(_fmt_pod(p))
            if not pods:
                lines.append("  No pods found.")
            sections.append("\n".join(lines))
        except Exception as ex:
            sections.append(f"PODS: error - {ex}")
    if intents & {"nodes","health"}:
        try:
            nodes = await openshift_client.get_nodes()
            if nodes:
                ready = sum(1 for n in nodes if any(c.get("type")=="Ready" and c.get("status")=="True" for c in n.get("status",{}).get("conditions",[])))
                lines = [f"LIVE NODES (total={len(nodes)} ready={ready}):"]
                for n in nodes[:15]:
                    meta = n.get("metadata",{}); status = n.get("status",{})
                    rdy = next((c.get("status") for c in status.get("conditions",[]) if c.get("type")=="Ready"), "?")
                    alloc = status.get("allocatable",{})
                    lines.append(f"  node {meta.get('name','?')}  ready={rdy}  cpu={alloc.get('cpu','?')}  mem={alloc.get('memory','?')}")
                sections.append("\n".join(lines))
            else:
                sections.append("LIVE NODES: Not accessible (insufficient permissions)")
        except Exception as ex:
            sections.append(f"NODES: error - {ex}")
    if intents & {"deployments","scale"}:
        try:
            deps = await openshift_client.get_deployments()
            degraded = [d for d in deps if d.get("status",{}).get("readyReplicas",0) < d.get("spec",{}).get("replicas",1)]
            lines = [f"LIVE DEPLOYMENTS (total={len(deps)} degraded={len(degraded)}):"]
            # Cap at 10 deployments
            for d in (degraded or deps)[:10]:
                lines.append(_fmt_deployment(d))
            sections.append("\n".join(lines))
        except Exception as ex:
            sections.append(f"DEPLOYMENTS: error - {ex}")
    if intents & {"events","health"}:
        try:
            evts = await openshift_client.get_events()
            warns = [e for e in evts if e.get("type") in ("Warning","Error")]
            lines = [f"LIVE EVENTS (total={len(evts)} warnings={len(warns)}):"]
            # Cap at 5 warning events
            for e in warns[:5]:
                lines.append(_fmt_event(e))
            if not warns:
                lines.append("  No Warning/Error events.")
            sections.append("\n".join(lines))
        except Exception as ex:
            sections.append(f"EVENTS: error - {ex}")
    return "\n\n".join(sections)

async def _rca_evidence(request: "ChatRequest", intents: set) -> Optional[str]:
    """For root-cause style questions, collect live evidence (status, events, logs,
    node, dependency pods) so the LLM can answer with proof instead of guessing."""
    inc = request.incident
    if not inc and not is_rca_question(request.message, intents):
        return None
    history_text = " ".join(m.content for m in (request.conversation_history or [])[-6:] if m.role == "user")
    try:
        if inc and inc.kind == "Node":
            evidence = await investigate_node(inc.name)
        elif inc and inc.kind == "Pod" and inc.namespace:
            evidence = await investigate(request.message, history_text, force=(inc.namespace, inc.name))
            if not evidence:
                return (f"INVESTIGATION: pod {inc.namespace}/{inc.name} no longer exists or is not accessible "
                        "(it may have been replaced after a restart or rollout).")
        else:
            evidence = await investigate(request.message, history_text)
    except Exception as ex:
        return f"INVESTIGATION ERROR: could not collect evidence ({ex})"
    if not evidence:
        return "INVESTIGATION: no unhealthy or matching pods were found in the accessible namespaces."
    return "INVESTIGATION EVIDENCE (collected live from the cluster):\n" + evidence

@app.get("/")
async def root():
    return {"service": "OpenShift AI Assistant API", "status": "running", "version": "3.0.0"}

@app.get("/health")
async def health_check():
    wx_healthy  = await watsonx_client.check_health()
    ica_healthy = await ica_client.check_health()
    return {
        "api": "healthy",
        "watsonx_ai": "healthy" if wx_healthy else "unavailable",
        "ica": "healthy" if ica_healthy else ("unconfigured" if not settings.ica_api_key else "unavailable"),
        "model": settings.watsonx_model,
    }

@app.post("/api/chat/ica", response_model=ChatResponse)
async def chat_ica(request: ChatRequest):
    """Chat endpoint that uses IBM Consulting Advantage (ICA) instead of watsonx.ai."""
    if _is_write_request(request.message, generated=bool(request.incident)):
        return ChatResponse(response=_READ_ONLY_REPLY)
    if not settings.ica_api_key:
        raise HTTPException(status_code=503, detail="ICA_API_KEY is not configured on the server.")
    try:
        intents = _detect_intents(request.message)
        context_parts: List[str] = []
        action_summary = None
        action_success = None

        rca_mode = bool(request.incident) or is_rca_question(request.message, intents)
        parsed_action = _parse_action(request.message)
        if rca_mode and parsed_action and parsed_action["action"] in ("logs", "describe"):
            parsed_action = None  # the investigation already collects logs/status
        if parsed_action:
            summary, ok = await _execute_action(parsed_action)
            action_summary = summary
            action_success = ok
            context_parts.append(
                f"CLUSTER ACTION EXECUTED:\n"
                f"  Action  : {parsed_action['action'].upper()} {parsed_action['kind']}\n"
                f"  Target  : {parsed_action.get('name','?')} in {parsed_action.get('namespace','?')}\n"
                f"  Result  : {'SUCCESS' if ok else 'FAILED'} - {summary}"
            )
            intents.update({"pods", "namespaces"})

        if intents:
            cluster_ctx = await _build_cluster_context(intents)
            if cluster_ctx == "TOKEN_EXPIRED":
                return ChatResponse(
                    response="⚠️ **OpenShift token expired.** Use 'Connect to cluster' in the header to reconnect.",
                    action_performed=None, action_success=None, context_used=None
                )
            if cluster_ctx:
                context_parts.append(cluster_ctx)

        if rca_mode:
            rca_ctx = await _rca_evidence(request, intents)
            if rca_ctx:
                context_parts.insert(0, rca_ctx)

        context = "\n\n".join(context_parts) if context_parts else None
        history = None
        if request.conversation_history:
            history = [{"role": m.role, "content": m.content} for m in request.conversation_history]

        response = await ica_client.answer_question(
            question=request.message, context=context, conversation_history=history, rca=rca_mode)

        return ChatResponse(response=response, action_performed=action_summary,
                            action_success=action_success, context_used=context if context else None)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    if _is_write_request(request.message, generated=bool(request.incident)):
        return ChatResponse(response=_READ_ONLY_REPLY)
    try:
        intents = _detect_intents(request.message)
        context_parts: List[str] = []
        action_summary = None
        action_success = None

        rca_mode = bool(request.incident) or is_rca_question(request.message, intents)
        parsed_action = _parse_action(request.message)
        if rca_mode and parsed_action and parsed_action["action"] in ("logs", "describe"):
            parsed_action = None  # the investigation already collects logs/status
        if parsed_action:
            summary, ok = await _execute_action(parsed_action)
            action_summary = summary
            action_success = ok
            context_parts.append(
                f"CLUSTER ACTION EXECUTED:\n"
                f"  Action  : {parsed_action['action'].upper()} {parsed_action['kind']}\n"
                f"  Target  : {parsed_action.get('name','?')} in {parsed_action.get('namespace','?')}\n"
                f"  Result  : {'SUCCESS' if ok else 'FAILED'} - {summary}"
            )
            intents.update({"pods", "namespaces"})

        if intents:
            cluster_ctx = await _build_cluster_context(intents)
            if cluster_ctx == "TOKEN_EXPIRED":
                return ChatResponse(
                    response=(
                        "⚠️ **Cluster connection lost.**\n\n"
                        "The cluster rejected the current token. Click **Connect to cluster** in the dashboard header "
                        "and enter the cluster API URL and a valid token "
                        "(or update the `OPENSHIFT_TOKEN` secret and restart the backend)."
                    ),
                    action_performed=None, action_success=None, context_used=None
                )
            if cluster_ctx:
                context_parts.append(cluster_ctx)

        if rca_mode:
            rca_ctx = await _rca_evidence(request, intents)
            if rca_ctx:
                context_parts.insert(0, rca_ctx)

        context = "\n\n".join(context_parts) if context_parts else None
        history = None
        if request.conversation_history:
            history = [{"role": m.role, "content": m.content} for m in request.conversation_history]

        response = await watsonx_client.answer_question(
            question=request.message, context=context, conversation_history=history, rca=rca_mode)

        return ChatResponse(response=response, action_performed=action_summary,
                            action_success=action_success, context_used=context if context else None)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat/quick")
async def quick_chat(request: ChatRequest):
    if _is_write_request(request.message):
        return {"response": _READ_ONLY_REPLY}
    try:
        response = await watsonx_client.answer_question(question=request.message)
        return {"response": response}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/action")
async def execute_action_direct(request: ActionRequest):
    """Read-only actions only (logs, describe). Anything else is rejected."""
    if request.action not in _READ_ONLY_ACTIONS:
        raise HTTPException(status_code=403, detail="This application is read-only.")
    try:
        act = {"action": request.action, "kind": request.kind, "name": request.name or "",
               "namespace": request.namespace or _DEFAULT_NAMESPACE,
               "container": request.container, "tail_lines": request.tail_lines}
        summary, ok = await _execute_action(act)
        return {"result": summary, "success": ok}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/openshift/namespaces")
async def get_namespaces():
    try:
        return {"namespaces": await openshift_client.get_namespaces()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/openshift/pods")
async def get_pods(namespace: Optional[str] = None):
    try:
        return {"pods": await openshift_client.get_pods(namespace)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/openshift/nodes")
async def get_nodes():
    try:
        return {"nodes": await openshift_client.get_nodes()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/openshift/deployments")
async def get_deployments(namespace: Optional[str] = None):
    try:
        return {"deployments": await openshift_client.get_deployments(namespace)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/openshift/events")
async def get_events(namespace: Optional[str] = None):
    try:
        return {"events": await openshift_client.get_events(namespace)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/openshift/log-alerts")
async def get_log_alerts(hours: int = 24):
    try:
        return await openshift_client.scan_logs(max(1, min(hours, 72)))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/openshift/cluster-health", response_model=ClusterHealthResponse)
async def get_cluster_health():
    try:
        health_data = await openshift_client.get_cluster_health()
        ai_analysis = await watsonx_client.analyze_cluster_health(health_data)
        return ClusterHealthResponse(health_data=health_data, ai_analysis=ai_analysis)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/analyze/logs")
async def analyze_logs(request: AnalyzeLogsRequest):
    try:
        logs = await openshift_client.get_pod_logs(request.namespace, request.pod_name)
        analysis = await watsonx_client.analyze_logs(logs, f"Pod: {request.pod_name} ns: {request.namespace}")
        return {"logs": logs, "analysis": analysis}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/analyze/event")
async def analyze_event(event: Dict[str, Any]):
    try:
        return {"explanation": await watsonx_client.explain_event(event)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/suggestions")
async def get_suggestions():
    return {"suggestions": ["List all pods", "Analyze cluster health", "Show unhealthy pods",
                            "Why is my pod restarting? Give root cause", "Show warning events",
                            "Show namespaces"]}

<<<<<<< HEAD
@app.get("/api/openshift/token-status")
async def token_status():
    """Check if the OpenShift token is valid."""
    in_cluster = openshift_client.in_cluster
    probe = await openshift_client._api_request("/apis/project.openshift.io/v1/projects")
    if "401" in str(probe.get("error", "")):
        return {"status": "expired", "in_cluster": in_cluster, "message": "Token is expired — update OPENSHIFT_TOKEN in backend/.env and restart"}
    if "error" in probe:
        return {"status": "error", "in_cluster": in_cluster, "message": probe["error"]}
    count = len(probe.get("items", []))
    return {"status": "valid", "in_cluster": in_cluster, "accessible_projects": count}
=======
@app.get("/api/openshift/connection")
async def cluster_connection():
    """Report whether the backend can reach the cluster with its current credentials (read-only probe)."""
    server = openshift_client.api_url
    probe = await openshift_client._api_request("/version")
    if "401" in str(probe.get("error", "")) or "403" in str(probe.get("error", "")):
        return {"status": "unauthorized", "server": server, "message": "Cluster rejected the token — reconnect with a valid one"}
    if "error" in probe:
        return {"status": "disconnected", "server": server, "message": probe["error"]}
    return {"status": "connected", "server": server, "version": probe.get("gitVersion", "")}
>>>>>>> 1801054 (Add test file)

class ClusterConnectRequest(BaseModel):
    api_url: str
    token: str

<<<<<<< HEAD
@app.post("/api/openshift/update-token")
async def update_token(request: TokenUpdateRequest):
    """Hot-reload the OpenShift token without restarting the backend."""
    new_token = request.token.strip()
    if not new_token.startswith("sha256~"):
        raise HTTPException(status_code=400, detail="Token must start with sha256~")
    openshift_client.token = new_token
    # Verify it works
    probe = await openshift_client._api_request("/apis/project.openshift.io/v1/projects")
    if "401" in str(probe.get("error", "")):
        raise HTTPException(status_code=401, detail="New token is also invalid — check and try again")
    count = len(probe.get("items", []))
    return {"status": "ok", "message": f"Token updated. {count} project(s) accessible."}
=======
@app.post("/api/openshift/connect")
async def connect_cluster(request: ClusterConnectRequest):
    """Point the backend at a cluster (API URL + token) without restarting. In-memory only; read-only access."""
    api_url = request.api_url.strip().rstrip("/")
    token = request.token.strip()
    if not api_url.startswith("https://"):
        raise HTTPException(status_code=400, detail="Cluster API URL must start with https://")
    if not token:
        raise HTTPException(status_code=400, detail="Token is required")
    previous = (openshift_client.api_url, openshift_client.token, openshift_client.headers["Authorization"])
    openshift_client.api_url = api_url
    openshift_client.token = token
    openshift_client.headers["Authorization"] = f"Bearer {token}"
    probe = await openshift_client._api_request("/version")
    if "error" in probe:
        # Roll back so a bad attempt doesn't break a working connection
        openshift_client.api_url, openshift_client.token, openshift_client.headers["Authorization"] = previous
        code = 401 if "401" in str(probe["error"]) or "403" in str(probe["error"]) else 502
        raise HTTPException(status_code=code, detail=f"Could not connect: {probe['error']}")
    return {"status": "connected", "server": api_url, "version": probe.get("gitVersion", "")}
>>>>>>> 1801054 (Add test file)

@app.get("/api/watsonx/test")
async def test_watsonx():
    """Quick connectivity test — sends a minimal prompt to watsonx.ai and returns the reply."""
    if not settings.watsonx_project_id:
        return {"status": "error", "message": "WATSONX_PROJECT_ID is not set in backend/.env"}
    if not settings.watsonx_api_key:
        return {"status": "error", "message": "WATSONX_API_KEY is not set in backend/.env"}
    try:
        reply = await ica_client.answer_question("Reply with exactly: watsonx connection OK")
        return {"status": "ok", "model": settings.watsonx_model,
                "base_url": settings.watsonx_base_url, "reply": reply}
    except Exception as e:
        return {"status": "error", "message": str(e)}

# ─── ServiceNow Incidents ────────────────────────────────────────────────────

class IncidentModel(BaseModel):
    id: str
    number: str
    short_description: str
    description: str
    severity: str
    priority: str
    state: str
    category: str
    subcategory: str
    affected_service: str
    namespace: Optional[str] = None
    pod_name: Optional[str] = None
    node_name: Optional[str] = None
    assigned_to: str
    opened_at: str
    updated_at: str
    resolved_at: Optional[str] = None
    source: str = "Mock"


import datetime as _dt
import hashlib as _hashlib

INCIDENT_WINDOW_HOURS = 24
_ACTIVE_WINDOW_SECONDS = 3600  # seen again within the last hour => still active

# event reason -> (severity, category, subcategory)
_REASON_MAP: Dict[str, Tuple[str, str, str]] = {
    "BackOff":           ("2", "Application", "CrashLoopBackOff"),
    "CrashLoopBackOff":  ("1", "Application", "CrashLoopBackOff"),
    "OOMKilled":         ("1", "Performance", "Memory"),
    "Evicted":           ("2", "Infrastructure", "Eviction"),
    "NodeNotReady":      ("1", "Infrastructure", "Node"),
    "NodeHasDiskPressure":   ("2", "Infrastructure", "Node"),
    "NodeHasInsufficientMemory": ("2", "Infrastructure", "Node"),
    "Failed":            ("2", "Deployment", "Container Failure"),
    "FailedScheduling":  ("2", "Infrastructure", "Scheduling"),
    "FailedMount":       ("3", "Storage", "Volume Mount"),
    "FailedAttachVolume": ("3", "Storage", "Volume Attach"),
    "ErrImagePull":      ("2", "Deployment", "Image Pull"),
    "ImagePullBackOff":  ("2", "Deployment", "Image Pull"),
    "InspectFailed":     ("3", "Deployment", "Image Pull"),
    "Unhealthy":         ("3", "Application", "Probe Failure"),
    "FailedCreate":      ("3", "Deployment", "Controller"),
    "FailedGetResourceMetric": ("4", "Performance", "Autoscaling"),
}
_SEVERITY_PRIORITY = {"1": "Critical", "2": "High", "3": "Medium", "4": "Low"}


def _parse_ts(value: Optional[str]) -> Optional[_dt.datetime]:
    if not value:
        return None
    try:
        return _dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _event_time(ev: Dict[str, Any]) -> Optional[_dt.datetime]:
    series = ev.get("series") or {}
    return (_parse_ts(ev.get("lastTimestamp")) or _parse_ts(series.get("lastObservedTime"))
            or _parse_ts(ev.get("eventTime")) or _parse_ts(ev.get("metadata", {}).get("creationTimestamp")))


async def _build_cluster_incidents() -> List[Dict[str, Any]]:
    """
    Derive incidents from the live cluster: Warning events from the last 24 hours,
    grouped per (namespace, object, reason).
    """
    now = _dt.datetime.now(_dt.timezone.utc)
    cutoff = now - _dt.timedelta(hours=INCIDENT_WINDOW_HOURS)
    events = await openshift_client.get_events()

    groups: Dict[Tuple[str, str, str, str], Dict[str, Any]] = {}
    for ev in events:
        if ev.get("type") != "Warning":
            continue
        last = _event_time(ev)
        if not last or last < cutoff:
            continue
        obj = ev.get("involvedObject", {})
        reason = ev.get("reason", "Unknown")
        key = (obj.get("namespace") or ev.get("metadata", {}).get("namespace", ""),
               obj.get("kind", ""), obj.get("name", ""), reason)
        first = _parse_ts(ev.get("firstTimestamp")) or _parse_ts(ev.get("eventTime")) or last
        count = ev.get("count") or (ev.get("series") or {}).get("count") or 1
        g = groups.get(key)
        if g is None:
            groups[key] = {"first": first, "last": last, "count": count, "message": ev.get("message", ""),
                           "obj": obj, "reason": reason}
        else:
            g["first"] = min(g["first"], first)
            if last > g["last"]:
                g["last"], g["message"] = last, ev.get("message", "")
            g["count"] += count

    incidents: List[Dict[str, Any]] = []
    for (ns, kind, name, reason), g in groups.items():
        severity, category, subcategory = _REASON_MAP.get(reason, ("3", "Cluster Event", reason))
        age = (now - g["last"]).total_seconds()
        active = age <= _ACTIVE_WINDOW_SECONDS
        uid = _hashlib.sha1(f"{ns}/{kind}/{name}/{reason}".encode()).hexdigest()[:10]
        pod = name if kind == "Pod" else None
        incidents.append({
            "id": uid,
            "number": f"EVT-{uid[:7].upper()}",
            "short_description": f"{reason} on {kind}/{name}" + (f" in {ns}" if ns else ""),
            "description": f"{g['message']} (seen {g['count']} time(s) in the last {INCIDENT_WINDOW_HOURS}h)",
            "severity": severity, "priority": _SEVERITY_PRIORITY[severity],
            "state": "New" if active else "Resolved",
            "category": category, "subcategory": subcategory,
            "affected_service": name, "namespace": ns or None,
            "pod_name": pod, "node_name": name if kind == "Node" else None,
            "assigned_to": "Unassigned",
            "opened_at": g["first"].isoformat(), "updated_at": g["last"].isoformat(),
            "resolved_at": None if active else g["last"].isoformat(),
            "source": "Cluster",
        })
    # newest first, then active before resolved, then most severe first (stable sorts)
    incidents.sort(key=lambda i: i["updated_at"], reverse=True)
    incidents.sort(key=lambda i: (i["state"] != "New", i["severity"]))
    return incidents


@app.get("/api/incidents")
async def get_incidents(state: Optional[str] = None, severity: Optional[str] = None):
    """Incidents from the last 24 hours, derived from live cluster Warning events."""
    incidents = await _build_cluster_incidents()
    if state:
        incidents = [i for i in incidents if i["state"].lower() == state.lower()]
    if severity:
        incidents = [i for i in incidents if i["severity"] == severity]
    return {"incidents": incidents, "total": len(incidents), "window_hours": INCIDENT_WINDOW_HOURS,
            "source": "cluster"}

@app.post("/api/incidents/{incident_id}/analyze")
async def analyze_incident(incident_id: str):
    """
    Trigger AI-powered RCA for a specific incident.
    Fetches live cluster context for the affected namespace/pod and returns
    a structured RCA + remediation from the AI.
    """
    incident = next((i for i in await _build_cluster_incidents() if i["id"] == incident_id), None)
    if not incident:
        raise HTTPException(status_code=404, detail=f"Incident {incident_id} not found")

    # Build targeted RCA prompt
    prompt_parts = [
        f"Perform a Root Cause Analysis (RCA) for this incident:",
        f"Incident: {incident['number']} — {incident['short_description']}",
        f"Severity: {incident['priority']} (SEV{incident['severity']})",
        f"Description: {incident['description']}",
    ]
    if incident.get("namespace"):
        prompt_parts.append(f"Affected namespace: {incident['namespace']}")
    if incident.get("pod_name"):
        prompt_parts.append(f"Affected pod: {incident['pod_name']}")
    if incident.get("node_name"):
        prompt_parts.append(f"Affected node: {incident['node_name']}")

    prompt_parts += [
        "",
        "Please:",
        "1. Investigate the cluster (pods, events, logs, deployments)",
        "2. Identify the root cause",
        "3. Provide a detailed RCA",
        "4. List step-by-step remediation actions",
        "5. Suggest preventive measures",
    ]
    prompt = "\n".join(prompt_parts)

    intents = {"pods", "events", "health", "namespaces"}
    if incident.get("namespace"):
        intents.add("deployments")

    cluster_ctx = await _build_cluster_context(intents)
    context = cluster_ctx if cluster_ctx and cluster_ctx != "TOKEN_EXPIRED" else None

    try:
        response = await watsonx_client.answer_question(question=prompt, context=context)
        return {"incident_id": incident_id, "number": incident["number"], "rca": response}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run("main:app", host=settings.api_host, port=settings.api_port, reload=True)

# Made with Bob
