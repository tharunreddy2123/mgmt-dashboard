# Deploying AI-Dashboard to Red Hat OpenShift with Podman

This guide shows how to build the **frontend** and **backend** container images locally with Podman, push them to the OpenShift cluster, and deploy both using the manifests in this repo.

## 1. Architecture

```
Browser ──HTTPS──> Route (ai-dashboard)
                      │
                      ▼
          Service ai-dashboard-frontend :8080
          (nginx-unprivileged, serves React build)
                      │  /api/*  and /health
                      ▼
          Service ai-dashboard-backend :8000
          (FastAPI / uvicorn)
                      │
                      ▼
          OpenShift API, watsonx.ai, ICA
```

| Item | File |
|---|---|
| Frontend image | [`Dockerfile`](../Dockerfile) (multi-stage: Node build → nginx, port 8080) |
| nginx config (proxies `/api/` to backend) | [`nginx.conf`](../nginx.conf) |
| Backend image | [`backend/Dockerfile`](../backend/Dockerfile) (Python 3.11, port 8000, runs as non-root) |
| Kubernetes/OpenShift objects | [`openshift/app.yaml`](../openshift/app.yaml) (ImageStreams, Deployments, Services, Route) |

Both images are already OpenShift-compatible (non-root, arbitrary UID, group 0 permissions).

> The frontend calls the backend through nginx using the hostname `ai-dashboard-backend`, so **both must be deployed in the same namespace** and the service names must not change.

## 2. Prerequisites

- [Podman](https://podman.io/) installed. On Windows/macOS run `podman machine init` and `podman machine start` once.
- [`oc` CLI](https://docs.redhat.com/en/documentation/openshift_container_platform/) installed.
- Access to the cluster (API URL + login) and permission to create resources in a project.
- Secrets/keys: watsonx API key + project ID, ICA API key, and an OpenShift API URL/token for the app to query clusters.

Verify:

```powershell
podman --version
oc version --client
```

## 3. Log in to the cluster and create a project

```powershell
oc login --server=https://api.<your-cluster>:6443 --token=<your-token>
oc new-project ai-dashboard        # or: oc project <existing-project>
$NS = "ai-dashboard"
```

Get the login command from the OpenShift web console: top-right user menu → **Copy login command**.

## 4. Build the images locally with Podman

Run from the repository root. Use `--platform linux/amd64` if your laptop is ARM (Apple Silicon) and the cluster is x86.

```powershell
# Backend (build context = backend/)
podman build --platform linux/amd64 -t ai-dashboard-backend:latest -f backend/Dockerfile backend

# Frontend (build context = repo root)
podman build --platform linux/amd64 -t ai-dashboard-frontend:latest -f Dockerfile .
```

Optional local smoke test:

```powershell
podman run --rm -p 8000:8000 --env-file backend/.env ai-dashboard-backend:latest
# in another terminal
curl http://localhost:8000/health
```

(The frontend image will not fully work standalone, because nginx proxies to the in-cluster hostname `ai-dashboard-backend`.)

## 5. Push images to the OpenShift internal registry

### 5.1 Expose the registry route (one-time, needs cluster-admin)

```powershell
oc patch configs.imageregistry.operator.openshift.io/cluster --type=merge -p '{"spec":{"defaultRoute":true}}'
```

If this is already enabled, or your admin has given you the registry hostname, skip it.

### 5.2 Log Podman in to the registry

```powershell
$REGISTRY = oc get route default-route -n openshift-image-registry -o jsonpath='{.spec.host}'
podman login -u $(oc whoami) -p $(oc whoami -t) $REGISTRY --tls-verify=false
```

`--tls-verify=false` is only needed if the registry route uses a self-signed certificate. Prefer trusting the cluster CA where possible.

### 5.3 Tag and push

The image path is `<registry>/<namespace>/<imagestream>:<tag>`; the ImageStream names must match [`openshift/app.yaml`](../openshift/app.yaml).

```powershell
podman tag ai-dashboard-backend:latest  "$REGISTRY/$NS/ai-dashboard-backend:latest"
podman tag ai-dashboard-frontend:latest "$REGISTRY/$NS/ai-dashboard-frontend:latest"

podman push "$REGISTRY/$NS/ai-dashboard-backend:latest"  --tls-verify=false
podman push "$REGISTRY/$NS/ai-dashboard-frontend:latest" --tls-verify=false
```

Verify:

```powershell
oc get imagestream
oc get istag
```

> **Alternative: external registry (Quay.io, Docker Hub, ICR).** Tag/push there instead, then change `image:` in the two Deployments of `openshift/app.yaml` to the full external path and remove the `image.openshift.io/triggers` annotations. Add a pull secret if the registry is private (`oc create secret docker-registry ...` + `oc secrets link default <secret> --for=pull`).

## 6. Create the secret

The backend reads its configuration from the `ai-dashboard-secrets` secret (via `envFrom`). Variable names match [`backend/config.py`](../backend/config.py).

```powershell
oc create secret generic ai-dashboard-secrets `
  --from-literal=OPENSHIFT_API_URL='https://api.<target-cluster>:6443' `
  --from-literal=OPENSHIFT_TOKEN='sha256~<token>' `
  --from-literal=WATSONX_API_KEY='<key>' `
  --from-literal=WATSONX_PROJECT_ID='<project-id>' `
  --from-literal=WATSONX_BASE_URL='https://eu-gb.ml.cloud.ibm.com' `
  --from-literal=WATSONX_MODEL='meta-llama/llama-3-3-70b-instruct' `
  --from-literal=ICA_API_KEY='sk-<key>' `
  --from-literal=ICA_MODEL='meta-llama/llama-4-maverick-17b-128e-instruct-fp8' `
  --dry-run=client -o yaml | oc apply -f -
```

Re-run the same command any time a value changes, then restart the backend: `oc rollout restart deployment/ai-dashboard-backend`.

Do not commit real values to Git.

## 7. Deploy to the cluster

```powershell
oc apply -f openshift/app.yaml
```

This creates:

- ImageStreams and (optional) BuildConfigs
- `ai-dashboard-backend` Deployment + Service (8000)
- `ai-dashboard-frontend` Deployment + Service (8080)
- `ai-dashboard` Route (edge TLS, HTTP → HTTPS redirect, 180s timeout for AI responses)

The Deployments use an ImageStream trigger, so they roll out automatically as soon as the pushed image appears in the ImageStream (and again on every future push of `:latest`).

If the Deployments were already waiting, force a rollout:

```powershell
oc rollout restart deployment/ai-dashboard-backend deployment/ai-dashboard-frontend
```

Wait for completion:

```powershell
oc rollout status deployment/ai-dashboard-backend  --timeout=300s
oc rollout status deployment/ai-dashboard-frontend --timeout=300s
```

## 8. Open the application

```powershell
"https://$(oc get route ai-dashboard -o jsonpath='{.spec.host}')"
```

Health check through the route:

```powershell
curl "https://$(oc get route ai-dashboard -o jsonpath='{.spec.host}')/health"
```

## 9. Updating the application

After code changes, rebuild, retag, push. The ImageStream trigger redeploys automatically.

```powershell
podman build --platform linux/amd64 -t ai-dashboard-backend:latest -f backend/Dockerfile backend
podman tag ai-dashboard-backend:latest "$REGISTRY/$NS/ai-dashboard-backend:latest"
podman push "$REGISTRY/$NS/ai-dashboard-backend:latest" --tls-verify=false
```

Same for the frontend (`-f Dockerfile .` and `ai-dashboard-frontend`).

For versioned, rollback-friendly releases, use a tag such as `:1.0.1` instead of `:latest` and update the trigger/image reference accordingly.

## 10. Alternative: let the cluster build the images (no local Podman)

[`openshift/app.yaml`](../openshift/app.yaml) also contains binary BuildConfigs, so you can upload the source and build in-cluster:

```powershell
oc start-build ai-dashboard-backend  --from-dir=backend --follow
oc start-build ai-dashboard-frontend --from-dir=.       --follow
```

This is what the GitHub Actions workflow [`.github/workflows/deploy-openshift.yml`](../.github/workflows/deploy-openshift.yml) does.

## 11. Troubleshooting

| Symptom | Check / fix |
|---|---|
| `ImagePullBackOff` / `ErrImagePull` | `oc get istag` — the image must exist in the ImageStream. Re-push. Confirm the push namespace equals the deployment namespace. |
| `podman push` → `unauthorized` | Token expired. Re-run `oc login` and `podman login`. |
| `podman push` → x509 certificate error | Use `--tls-verify=false` or trust the cluster router CA. |
| Frontend pod `CrashLoopBackOff`, log `host not found in upstream "ai-dashboard-backend"` | nginx resolves the backend at startup. Make sure `Service/ai-dashboard-backend` exists in the same namespace (`oc get svc`) and restart the frontend. |
| Backend pod not ready / `Error` | `oc logs deployment/ai-dashboard-backend`. Usually a missing secret: `oc get secret ai-dashboard-secrets`. |
| `exec format error` | Image built for the wrong architecture. Rebuild with `--platform linux/amd64` (or `arm64` for ARM clusters). |
| `502/504` on AI calls | Route and nginx timeouts are 180s. Check backend logs and that watsonx/ICA keys are valid. |
| Permission denied writing files in container | Containers run with an arbitrary UID. Write only to `/tmp` or `/app` (group-0 writable), not to root-owned paths. |
| Changed secret has no effect | `oc rollout restart deployment/ai-dashboard-backend`. |

Useful commands:

```powershell
oc get pods
oc logs -f deployment/ai-dashboard-backend
oc logs -f deployment/ai-dashboard-frontend
oc describe pod <pod-name>
oc get events --sort-by=.lastTimestamp
```

## 12. Cleanup

```powershell
oc delete -f openshift/app.yaml
oc delete secret ai-dashboard-secrets
# or remove everything:
oc delete project ai-dashboard
```
