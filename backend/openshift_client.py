import os
import httpx
import re
import time
from typing import List, Dict, Any, Optional
from config import settings
import asyncio

# Short-lived cache for successful GET responses, so the dashboard's parallel
# requests (and quick page switches) don't re-hit the cluster for the same data.
_CACHE_TTL = 8  # seconds
# Max concurrent per-namespace requests against the cluster API
_NS_CONCURRENCY = 10

# Log scan (Alerts page): bounded so a large cluster can't be hammered
_LOG_SCAN_TTL = 120            # seconds
_LOG_SCAN_CONCURRENCY = 8
_LOG_SCAN_MAX_CONTAINERS = 300
_LOG_SCAN_TAIL = 3000          # max lines examined per container within the window
_ERROR_RE = re.compile(r"\b(error|fatal|exception|panic|critical|traceback|failed)\b", re.IGNORECASE)
_WARN_RE = re.compile(r"\b(warn|warning)\b", re.IGNORECASE)

# Hard read-only enforcement: every request made by this module passes through this
# hook, so even a future coding mistake cannot send a write to the cluster.
#  - only GET is allowed
#  - pod/node/service subresources that open shells or tunnels (exec, attach,
#    portforward, proxy) are refused — a GET on /exec is a websocket exec
#  - ".." path segments are refused
_FORBIDDEN_SUBRESOURCE = re.compile(r"/(pods|nodes|services)/[^/]+/(exec|attach|portforward|proxy)(/|$)")


async def _read_only_guard(request: httpx.Request) -> None:
    path = request.url.path
    if request.method != "GET":
        raise PermissionError(f"Read-only: {request.method} requests to the cluster are not allowed.")
    if _FORBIDDEN_SUBRESOURCE.search(path) or ".." in path.split("/"):
        raise PermissionError(f"Read-only: access to {path} is not allowed.")


def _check_path(path: str) -> None:
    # Checked on the RAW path (httpx would silently normalise '..' into a different resource)
    if not path.startswith('/') or '..' in path.split('?')[0].split('/') or '//' in path.split('?')[0] or '\\' in path or re.search(r'%(2f|2e|5c)', path, re.I):
        raise PermissionError(f'Read-only: invalid cluster path {path!r}')


def _new_client(timeout, **kwargs) -> httpx.AsyncClient:
    return httpx.AsyncClient(verify=False, timeout=timeout,
                             event_hooks={"request": [_read_only_guard]}, **kwargs)

# ──────────────────────────────────────────────────────────────────────────────
# READ-ONLY TRANSPORT CONTRACT
#
# Every public method on OpenShiftClient MUST go through _api_request() or
# _api_request_text().  Both methods issue HTTP GET exclusively — there is no
# POST, PUT, PATCH, or DELETE anywhere in this file.
#
# If you need to add a new method, use _api_request / _api_request_text.
# Never add client.post / client.put / client.patch / client.delete here.
# ──────────────────────────────────────────────────────────────────────────────

class OpenShiftClient:
<<<<<<< HEAD
    """Client for interacting with OpenShift API and oc commands with retry logic"""
    
    # Security whitelist - only these commands are allowed
    ALLOWED_COMMANDS = [
        "oc get pods -A",
        "oc get pods -n {namespace}",
        "oc get nodes",
        "oc get events -A",
        "oc get events -n {namespace}",
        "oc get deployments -A",
        "oc get deployments -n {namespace}",
        "oc get namespaces",
        "oc get projects",
        "oc describe pod {pod} -n {namespace}",
        "oc describe node {node}",
        "oc logs {pod} -n {namespace}",
        "oc logs {pod} -n {namespace} --tail=100",
        "oc get all -n {namespace}",
        "oc scale deployment {name} --replicas={replicas} -n {namespace}",
        "oc scale deploymentconfig {name} --replicas={replicas} -n {namespace}",
        "oc scale replicationcontroller {name} --replicas={replicas} -n {namespace}",
        "oc scale statefulset {name} --replicas={replicas} -n {namespace}",
    ]
    
    # Service-account credentials that OpenShift mounts into every pod
    SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
    SA_NAMESPACE_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/namespace"
    IN_CLUSTER_API_URL = "https://kubernetes.default.svc"
    DEFAULT_API_URL = "https://api.rm3.7wse.p1.openshiftapps.com:6443"
=======
    """READ-ONLY client for the OpenShift API.

    All cluster communication is HTTP GET only. There are intentionally no
    create / update / delete / scale / exec / patch code paths.
    The _api_request and _api_request_text methods enforce this at the call site.
    """
>>>>>>> 1801054 (Add test file)

    def __init__(self):
        # Explicit token (env var or pasted in the UI) takes priority over the in-cluster one
        self._token_override = settings.openshift_token
        self.api_url = settings.openshift_api_url or (
            self.IN_CLUSTER_API_URL if self.in_cluster else self.DEFAULT_API_URL
        )
        self.max_retries = settings.max_retries
        self.retry_delay = settings.retry_delay
        self.timeout = settings.request_timeout

    @property
    def in_cluster(self) -> bool:
        """True when running inside a pod and no explicit token has been provided."""
        return not self._token_override and os.path.isfile(self.SA_TOKEN_PATH)

    @property
    def token(self) -> str:
        if self._token_override:
            return self._token_override
        # Re-read on every access: OpenShift rotates service-account tokens
        try:
            with open(self.SA_TOKEN_PATH) as f:
                return f.read().strip()
        except OSError:
            return ""

    @token.setter
    def token(self, value: str):
        self._token_override = value

    @property
    def headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json"
        }
        self._client: Optional[httpx.AsyncClient] = None
        self._cache: Dict[str, tuple] = {}
        self._inflight: Dict[str, "asyncio.Future"] = {}
        self._log_scan_cache: Dict[int, tuple] = {}

    def _get_client(self) -> httpx.AsyncClient:
        """Shared client: keeps TLS connections alive instead of re-handshaking per request."""
        if self._client is None or self._client.is_closed:
            self._client = _new_client(
                self.timeout,
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=20),
            )
        return self._client

    async def _api_request(self, path: str) -> Dict[str, Any]:
        """Cached + de-duplicated wrapper around _api_request_uncached."""
        cached = self._cache.get(path)
        if cached and time.monotonic() - cached[0] < _CACHE_TTL:
            return cached[1]
        pending = self._inflight.get(path)
        if pending is not None:
            return await pending
        future = asyncio.get_running_loop().create_future()
        self._inflight[path] = future
        try:
            data = await self._api_request_uncached(path)
            if "error" not in data:
                self._cache[path] = (time.monotonic(), data)
            future.set_result(data)
            return data
        except BaseException as e:
            future.set_exception(e)
            future.exception()  # mark retrieved to avoid "never retrieved" warnings
            raise
        finally:
            self._inflight.pop(path, None)

    async def _gather_per_namespace(self, path_template: str) -> List[Dict[str, Any]]:
        """Fetch a per-namespace list for all accessible namespaces concurrently."""
        namespaces = await self.get_namespaces()
        sem = asyncio.Semaphore(_NS_CONCURRENCY)

        async def one(ns_name: str) -> List[Dict[str, Any]]:
            async with sem:
                data = await self._api_request(path_template.format(ns=ns_name))
                return data.get("items", [])

        names = [n.get("metadata", {}).get("name") for n in namespaces]
        results = await asyncio.gather(*(one(n) for n in names if n))
        return [item for items in results for item in items]

    async def _api_request_uncached(self, path: str) -> Dict[str, Any]:
        """Make a READ-ONLY (GET) JSON request to OpenShift API with retry logic.

        This method only ever calls client.get(). No other HTTP verb is used.
        """
        # Safety assertion: path must not carry a body or mutation hint
        _check_path(path)
        url = f"{self.api_url}{path}"
        last_error = None
        for attempt in range(self.max_retries):
            try:
                client = self._get_client()
                # ← GET only — never change this to post/put/patch/delete
                response = await client.get(url, headers=self.headers)
                if response.status_code in (401, 403):
                    last_error = f"HTTP {response.status_code}: insufficient permissions for {path}"
                    break  # do not retry auth errors
                response.raise_for_status()
                return response.json()
            except httpx.TimeoutException:
                last_error = f"Request timeout after {self.timeout}s"
            except httpx.ConnectError:
                last_error = f"Connection failed to OpenShift API at {self.api_url}"
            except httpx.HTTPError as e:
                last_error = str(e)
            except Exception as e:
                last_error = f"Unexpected error: {str(e)}"
            if attempt < self.max_retries - 1:
                await asyncio.sleep(self.retry_delay * (attempt + 1))
        return {"error": last_error, "items": []}

    async def _api_request_text(self, path: str, timeout: int = 60, quiet: bool = False) -> str:
        """Make a READ-ONLY (GET) plain-text request to OpenShift API (used for pod logs).

        This method only ever calls client.get(). No other HTTP verb is used.
        """
        _check_path(path)
        url = f"{self.api_url}{path}"
        if not quiet:
            print(f"[LOG REQUEST] GET {url}", flush=True)
        try:
            async with _new_client(timeout) as client:
                # ← GET only — never change this to post/put/patch/delete
                response = await client.get(url, headers=self.headers)
                if quiet:
                    if response.status_code == 401:
                        return "Error: HTTP 401 - token expired or invalid"
                    if response.status_code == 403:
                        return "Error: HTTP 403 - insufficient permissions"
                    if response.status_code >= 400:
                        return f"Error: HTTP {response.status_code}"
                    return response.text
                print(f"[LOG RESPONSE] status={response.status_code} len={len(response.text)} bytes", flush=True)
                if response.status_code == 401:
                    return "Error: HTTP 401 - token expired or invalid"
                if response.status_code == 403:
                    # Return the K8s error body — it names exactly what RBAC rule is missing
                    try:
                        body = response.json()
                        msg = body.get("message") or body.get("reason") or "insufficient permissions"
                    except Exception:
                        msg = response.text[:300] or "insufficient permissions"
                    print(f"[LOG 403] {msg}", flush=True)
                    return f"Error: HTTP 403 - {msg}"
                response.raise_for_status()
                print(f"[LOG CONTENT] first 200 chars: {response.text[:200]!r}", flush=True)
                return response.text
        except Exception as e:
            print(f"[LOG EXCEPTION] {e}", flush=True)
            return f"Error fetching logs: {str(e)}"

    async def get_namespaces(self) -> List[Dict[str, Any]]:
        """Get accessible projects/namespaces for this user"""
        data = await self._api_request("/apis/project.openshift.io/v1/projects")
        items = data.get("items", [])
        if not items and settings.watch_namespaces_list:
            # Explicit list for service accounts that can't list projects
            return [{"metadata": {"name": n}, "status": {"phase": "Active"}}
                    for n in settings.watch_namespaces_list]
        if not items and self.in_cluster:
            # Service account can't list projects: fall back to the namespace the pod runs in
            try:
                with open(self.SA_NAMESPACE_PATH) as f:
                    own_ns = f.read().strip()
                if own_ns:
                    return [{"metadata": {"name": own_ns}, "status": {"phase": "Active"}}]
            except OSError:
                pass
        return items

    async def get_pods(self, namespace: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get pods - queries per accessible namespace (no cluster-wide list permission needed)"""
        if namespace:
            data = await self._api_request(f"/api/v1/namespaces/{namespace}/pods")
            return data.get("items", [])
        return await self._gather_per_namespace("/api/v1/namespaces/{ns}/pods")

    async def get_nodes(self) -> List[Dict[str, Any]]:
        """Get cluster nodes - returns empty list if user lacks cluster-admin permission"""
        data = await self._api_request("/api/v1/nodes")
        # 403 is expected for non-admin users; return empty without error
        if "error" in data and "403" in str(data.get("error", "")):
            return []
        return data.get("items", [])

    async def get_deployments(self, namespace: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get deployments per accessible namespace"""
        if namespace:
            data = await self._api_request(f"/apis/apps/v1/namespaces/{namespace}/deployments")
            return data.get("items", [])
        return await self._gather_per_namespace("/apis/apps/v1/namespaces/{ns}/deployments")

    async def get_events(self, namespace: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get events per accessible namespace"""
        if namespace:
            data = await self._api_request(f"/api/v1/namespaces/{namespace}/events")
            return data.get("items", [])
        return await self._gather_per_namespace("/api/v1/namespaces/{ns}/events")

    async def get_pod_logs(self, namespace: str, pod_name: str, tail_lines: int = 0, container: Optional[str] = None) -> str:
        """Get logs from a specific pod.

        For crashed/CrashLoopBackOff pods the current container may be in waiting
        state with no output — so we also try &previous=true to fetch the last
        terminated container's logs as a fallback.

        Also falls back to every other container in the pod spec if a 403 is
        returned (common in shared namespaces).
        """
        async def _fetch(ctr: Optional[str], previous: bool = False) -> str:
            params: List[str] = []
            # tail_lines=0 means fetch all logs (no limit)
            if tail_lines and tail_lines > 0:
                params.append(f"tailLines={tail_lines}")
            if ctr:
                params.append(f"container={ctr}")
            if previous:
                params.append("previous=true")
            qs = ("?" + "&".join(params)) if params else ""
            path = f"/api/v1/namespaces/{namespace}/pods/{pod_name}/log{qs}"
            return await self._api_request_text(path, timeout=60)

        result = await _fetch(container)

        # Empty output on a live container — try previous (last crashed) container logs
        if result.strip() == "" or result.strip() == "(no log output)":
            prev = await _fetch(container, previous=True)
            # Only use previous if it actually returned content (not an error)
            if prev.strip() and not prev.startswith("Error"):
                return f"[previous container logs]\n{prev}"
            # Still nothing — return the original empty result
            return result

        if not result.startswith("Error: HTTP 403"):
            return result

        # 403 on the requested container — fetch pod spec and try each container
        pod_data = await self._api_request(f"/api/v1/namespaces/{namespace}/pods/{pod_name}")
        containers: List[str] = [
            c.get("name", "") for c in
            pod_data.get("spec", {}).get("containers", [])
            if c.get("name") and c.get("name") != container
        ]
        for ctr in containers:
            alt = await _fetch(ctr)
            if not alt.startswith("Error: HTTP 403"):
                return f"[container: {ctr}]\n{alt}"

        # All containers returned 403 — surface a clear RBAC message
        all_ctrs = ([container] if container else []) + containers
        ctr_list = ", ".join(all_ctrs) if all_ctrs else "unknown"
        return (
            f"Error: Logs are not accessible for this pod.\n\n"
            f"The cluster token does not have 'get' permission on the pods/log "
            f"sub-resource in namespace '{namespace}'.\n\n"
            f"Containers in this pod: {ctr_list}\n\n"
            f"To fix: ask a cluster admin to grant:\n"
            f"  verb: get  resource: pods/log  namespace: {namespace}"
        )

    async def scan_logs(self, hours: int = 24) -> Dict[str, Any]:
        """Scan the last `hours` of container logs for error / warning lines.

        READ-ONLY: uses GET on the pods/log sub-resource only. Results are cached
        briefly because a full scan touches every container in the cluster.
        """
        cached = self._log_scan_cache.get(hours)
        if cached and time.monotonic() - cached[0] < _LOG_SCAN_TTL:
            return cached[1]

        pods = await self.get_pods()
        targets: List[tuple] = []
        for p in pods:
            if p.get("status", {}).get("phase") not in ("Running", "Failed"):
                continue
            meta = p.get("metadata", {})
            for c in p.get("spec", {}).get("containers", []):
                if c.get("name"):
                    targets.append((meta.get("namespace"), meta.get("name"), c["name"]))
        total_containers = len(targets)
        targets = targets[:_LOG_SCAN_MAX_CONTAINERS]

        sem = asyncio.Semaphore(_LOG_SCAN_CONCURRENCY)
        since = hours * 3600

        async def scan_one(ns: str, pod: str, ctr: str) -> Optional[Dict[str, Any]]:
            async with sem:
                path = (f"/api/v1/namespaces/{ns}/pods/{pod}/log"
                        f"?container={ctr}&sinceSeconds={since}&timestamps=true&tailLines={_LOG_SCAN_TAIL}")
                text = await self._api_request_text(path, timeout=30, quiet=True)
            if text.startswith("Error:"):
                return {"inaccessible": True}
            errors: List[Dict[str, str]] = []
            warnings: List[Dict[str, str]] = []
            err_n = warn_n = 0
            for line in text.splitlines():
                if _ERROR_RE.search(line):
                    level = "error"
                elif _WARN_RE.search(line):
                    level = "warning"
                else:
                    continue
                ts, _, msg = line.partition(" ")
                sample = {"ts": ts, "level": level, "message": (msg or line)[:400]}
                if level == "error":
                    err_n += 1
                    errors.append(sample)
                else:
                    warn_n += 1
                    warnings.append(sample)
            if not err_n and not warn_n:
                return None
            return {
                "namespace": ns, "pod": pod, "container": ctr,
                "error_count": err_n, "warning_count": warn_n,
                "samples": errors[-5:] + warnings[-3:],
            }

        results = await asyncio.gather(*(scan_one(*t) for t in targets))
        findings = [r for r in results if r and not r.get("inaccessible")]
        findings.sort(key=lambda f: (f["error_count"], f["warning_count"]), reverse=True)
        data = {
            "window_hours": hours,
            "containers_total": total_containers,
            "containers_scanned": len(targets),
            "inaccessible": sum(1 for r in results if r and r.get("inaccessible")),
            "findings": findings,
        }
        self._log_scan_cache[hours] = (time.monotonic(), data)
        return data

    async def get_cluster_health(self) -> Dict[str, Any]:
        """Get overall cluster health across all accessible namespaces"""
        pods   = await self.get_pods()
        nodes  = await self.get_nodes()
        events = await self.get_events()

        total_pods   = len(pods)
        running_pods = sum(1 for p in pods if p.get("status", {}).get("phase") == "Running")
        failed_pods  = sum(1 for p in pods if p.get("status", {}).get("phase") == "Failed")
        pending_pods = sum(1 for p in pods if p.get("status", {}).get("phase") == "Pending")

        total_nodes = len(nodes)
        ready_nodes = sum(
            1 for n in nodes
            if any(c.get("type") == "Ready" and c.get("status") == "True"
                   for c in n.get("status", {}).get("conditions", []))
        )

        recent_warnings = [e for e in events if e.get("type") in ("Warning", "Error")][:10]

        return {
            "pods":  {"total": total_pods, "running": running_pods,
                      "failed": failed_pods, "pending": pending_pods},
            "nodes": {"total": total_nodes, "ready": ready_nodes},
            "recent_warnings": recent_warnings,
        }
    

    async def describe_pod(self, namespace: str, pod_name: str) -> str:
        """Get full pod description as formatted text (mirrors oc describe pod)"""
        pod_data, events_data = await asyncio.gather(
            self._api_request(f"/api/v1/namespaces/{namespace}/pods/{pod_name}"),
            self._api_request(
                f"/api/v1/namespaces/{namespace}/events"
                f"?fieldSelector=involvedObject.name={pod_name},involvedObject.namespace={namespace}"
            ),
        )
        if "error" in pod_data:
            return f"Error: {pod_data['error']}"

        meta   = pod_data.get("metadata", {})
        spec   = pod_data.get("spec", {})
        status = pod_data.get("status", {})

        lines = [
            f"Name:       {meta.get('name','?')}",
            f"Namespace:  {meta.get('namespace','?')}",
            f"Node:       {spec.get('nodeName','?')}",
            f"Phase:      {status.get('phase','?')}",
            f"Pod IP:     {status.get('podIP','?')}",
            f"Host IP:    {status.get('hostIP','?')}",
            f"Start Time: {meta.get('creationTimestamp','?')}",
            f"Labels:     {', '.join(f'{k}={v}' for k, v in meta.get('labels', {}).items()) or '<none>'}",
        ]

        # QoS class
        if status.get("qosClass"):
            lines.append(f"QoS Class:  {status['qosClass']}")

        # Containers
        container_specs = {c["name"]: c for c in spec.get("containers", [])}
        container_statuses = {cs["name"]: cs for cs in status.get("containerStatuses", [])}
        init_specs = {c["name"]: c for c in spec.get("initContainers", [])}
        init_statuses = {cs["name"]: cs for cs in status.get("initContainerStatuses", [])}

        def _fmt_container(cspec: dict, cstatus: dict) -> List[str]:
            out = []
            out.append(f"  Name:    {cspec.get('name','?')}")
            out.append(f"  Image:   {cspec.get('image','?')}")

            # Resource requests / limits
            res = cspec.get("resources", {})
            req = res.get("requests", {})
            lim = res.get("limits", {})
            if req or lim:
                out.append(f"  Resources:")
                if req:
                    out.append(f"    Requests: cpu={req.get('cpu','?')}  memory={req.get('memory','?')}")
                if lim:
                    out.append(f"    Limits:   cpu={lim.get('cpu','?')}  memory={lim.get('memory','?')}")

            # Ports
            ports = cspec.get("ports", [])
            if ports:
                p_str = ", ".join(f"{p.get('containerPort','?')}/{p.get('protocol','TCP')}" for p in ports)
                out.append(f"  Ports:   {p_str}")

            # Current state
            state = cstatus.get("state", {})
            if state:
                if "running" in state:
                    started = state["running"].get("startedAt", "?")
                    out.append(f"  State:   Running (started: {started})")
                elif "waiting" in state:
                    w = state["waiting"]
                    out.append(f"  State:   Waiting")
                    if w.get("reason"):
                        out.append(f"    Reason:  {w['reason']}")
                    if w.get("message"):
                        out.append(f"    Message: {w['message']}")
                elif "terminated" in state:
                    t = state["terminated"]
                    out.append(f"  State:   Terminated")
                    if t.get("reason"):
                        out.append(f"    Reason:    {t['reason']}")
                    if t.get("message"):
                        out.append(f"    Message:   {t['message']}")
                    out.append(f"    Exit Code: {t.get('exitCode', '?')}")
                    if t.get("startedAt"):
                        out.append(f"    Started:   {t['startedAt']}")
                    if t.get("finishedAt"):
                        out.append(f"    Finished:  {t['finishedAt']}")

            # Last (previous) state
            last_state = cstatus.get("lastState", {})
            if last_state.get("terminated"):
                t = last_state["terminated"]
                out.append(f"  Last State: Terminated")
                if t.get("reason"):
                    out.append(f"    Reason:    {t['reason']}")
                if t.get("message"):
                    out.append(f"    Message:   {t['message']}")
                out.append(f"    Exit Code: {t.get('exitCode', '?')}")
                if t.get("finishedAt"):
                    out.append(f"    Finished:  {t['finishedAt']}")

            out.append(f"  Ready:    {cstatus.get('ready', '?')}")
            out.append(f"  Restarts: {cstatus.get('restartCount', 0)}")
            return out

        if init_specs:
            lines.append("\nInit Containers:")
            for name, cspec in init_specs.items():
                cstatus = init_statuses.get(name, {})
                lines.extend(_fmt_container(cspec, cstatus))

        lines.append("\nContainers:")
        for name, cspec in container_specs.items():
            cstatus = container_statuses.get(name, {})
            lines.extend(_fmt_container(cspec, cstatus))

        # Conditions
        conditions = status.get("conditions", [])
        if conditions:
            lines.append("\nConditions:")
            for cond in conditions:
                reason = f"  reason={cond['reason']}" if cond.get("reason") else ""
                msg    = f"  message={cond['message']}" if cond.get("message") else ""
                ctype  = str(cond.get("type") or "?")
                cstat  = str(cond.get("status") or "?")
                lines.append(f"  {ctype}: {cstat}{reason}{msg}")

        # Volumes
        volumes = spec.get("volumes", [])
        if volumes:
            lines.append("\nVolumes:")
            for v in volumes[:10]:
                vtype = next((k for k in v if k != "name"), "unknown")
                lines.append(f"  {v.get('name','?')} ({vtype})")

        # Tolerations
        tolerations = spec.get("tolerations", [])
        if tolerations:
            lines.append(f"\nTolerations: {len(tolerations)} rule(s)")

        # Events related to this pod
        events = events_data.get("items", [])
        if events:
            # Sort by last timestamp descending
            events_sorted = sorted(
                events,
                key=lambda e: e.get("lastTimestamp") or e.get("eventTime") or "",
                reverse=True,
            )
            lines.append("\nEvents:")
            lines.append(f"  {'Type':<10} {'Reason':<25} {'Age':<14} {'Message'}")
            lines.append(f"  {'----':<10} {'------':<25} {'---':<14} {'-------'}")
            for e in events_sorted[:15]:
                etype  = str(e.get("type") or "?")
                reason = str(e.get("reason") or "?")
                age_raw = e.get("lastTimestamp") or e.get("firstTimestamp") or "?"
                # Trim ISO timestamp to just the time portion for readability
                age = str(age_raw)
                if "T" in age:
                    age = age.split("T")[-1].rstrip("Z")
                msg = str(e.get("message") or "")[:120]
                lines.append(f"  {etype:<10} {reason:<25} {age:<14} {msg}")
        else:
            lines.append("\nEvents:  <none>")

        return "\n".join(lines)


# Singleton instance
openshift_client = OpenShiftClient()

# Made with Bob
