# OpenShift AI Assistant

AI-powered dashboard for OpenShift cluster management (React + FastAPI + IBM watsonx.ai).

## Run locally

```powershell
# Frontend
npm install
Copy-Item .env.example .env

# Backend (second terminal)
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env        # fill in values
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Frontend (first terminal, repo root)
npm run dev                         # http://localhost:5173
```

## Deploy to Red Hat OpenShift

Architecture: an nginx **frontend** (serves the SPA and proxies `/api` and `/health`) and a FastAPI **backend**, both built in-cluster with `BuildConfig`s and exposed through a single TLS `Route`. See [`openshift/app.yaml`](openshift/app.yaml).

### Read-only by design

The application (and the watsonx.ai assistant) can only **read** the cluster: pods, logs, events, nodes, deployments, namespaces. There is no code path that creates, updates, deletes, scales, restarts or execs. Chat requests asking for such changes are refused before any model call, and `/api/action` only accepts `logs` and `describe`.

Defence in depth: give the app a token from a service account that only has the `view` role, so the cluster itself rejects writes even if the code were changed:

```bash
oc create serviceaccount ai-dashboard-reader -n <namespace>
oc adm policy add-cluster-role-to-user view -z ai-dashboard-reader -n <namespace>   # or `view` per project
oc create token ai-dashboard-reader -n <namespace> --duration=8760h                  # -> APP_OPENSHIFT_TOKEN
```

Note: `view` does not include `pods/log` for every cluster configuration or node access; grant `get` on `pods/log` and `nodes` as read-only extras if you need them.

### GitHub repository secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret | Required | Description |
|--------|----------|-------------|
| `OPENSHIFT_SERVER` | yes | API URL, e.g. `https://api.<cluster>:6443` |
| `OPENSHIFT_TOKEN` | yes | Token the **pipeline** uses to deploy (needs edit rights on the project) |
| `APP_OPENSHIFT_TOKEN` | yes | **Read-only** (`view`) service-account token used by the running app |
| `OPENSHIFT_NAMESPACE` | yes | Target project |
| `WATSONX_API_KEY` | yes | watsonx.ai API key |
| `WATSONX_PROJECT_ID` | yes | watsonx.ai project ID |

Pushing to `main` runs [`.github/workflows/deploy-openshift.yml`](.github/workflows/deploy-openshift.yml), which creates the `ai-dashboard-secrets` Secret, applies the manifests, builds both images on the cluster and rolls out. The app URL is printed at the end (`oc get route ai-dashboard`).

### Manual deploy

```bash
oc project <namespace>
oc create secret generic ai-dashboard-secrets \
  --from-literal=OPENSHIFT_API_URL=... --from-literal=OPENSHIFT_TOKEN=<read-only-token> \
  --from-literal=WATSONX_API_KEY=... --from-literal=WATSONX_PROJECT_ID=...
oc apply -f openshift/app.yaml
oc start-build ai-dashboard-backend  --from-dir=backend --follow
oc start-build ai-dashboard-frontend --from-dir=. --follow
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/chat` | Chat with cluster context |
| GET | `/api/openshift/{namespaces,pods,nodes,deployments,events}` | Cluster resources |
| GET | `/api/openshift/cluster-health` | Cluster health + AI analysis |
| POST | `/api/action` | Read-only: `logs` / `describe` only (others return 403) |
| POST | `/api/analyze/logs` | AI log analysis |
| GET | `/health` | Health check |
