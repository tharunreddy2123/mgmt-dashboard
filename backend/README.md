# OpenShift AI Assistant — Backend

FastAPI service that talks to the OpenShift API and IBM watsonx.ai.

## Run locally

```bash
python -m venv venv
.\venv\Scripts\Activate.ps1        # Linux/macOS: source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                # fill in values
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Health check: http://localhost:8000/health

## Configuration (environment variables)

| Variable | Purpose |
|----------|---------|
| `OPENSHIFT_API_URL` | OpenShift API server URL |
| `OPENSHIFT_TOKEN` | Token (`sha256~…`) used to query the cluster |
| `WATSONX_API_KEY`, `WATSONX_PROJECT_ID` | IBM watsonx.ai credentials |
| `WATSONX_BASE_URL`, `WATSONX_MODEL` | watsonx.ai endpoint / model (have defaults) |
| `CORS_ORIGINS` | Comma-separated allowed origins |

On OpenShift these come from the `ai-dashboard-secrets` Secret (see the root README).
