# Proposal: Automated ingestion of canonical API reference collections into Postman

## Summary
This proposal outlines a pragmatic path to host canonical API reference collections in Postman for a customer whose services are primarily serverless behind AWS API Gateway (REST v1 and HTTP v2) with specs auto‑generated from frameworks like FastAPI. It covers:
- A small‑scope proof of concept (manual and minimal automation)
- First‑time bulk ingestion of all services
- Ongoing synchronization when new app versions are released

Technologies assumed: AWS API Gateway (REST/HTTP), AWS Lambda, GitHub Actions (primary CI), GitLab for SDLC tracking (optional hooks), Postman API, optional openapi‑to‑postman conversion for maximum control.

## Goals and non‑goals
- Goals
  - Surface a single source of truth for API reference in Postman (Spec Hub + reference Collection).
  - Automate ingestion from API Gateway or service endpoints with resilient, idempotent jobs.
  - Keep Postman assets up‑to‑date with minimal human intervention, and with traceability to code releases.
- Non‑goals
  - Replace existing SDLC; instead, augment with hooks.
  - Build exhaustive integration tests; we focus on reference collections and synchronization.

## High‑level approach
Spec Hub–first flow:
- Export OpenAPI from AWS or service endpoint
- Create or resolve a Spec in Spec Hub, upload the spec as a new version
- Generate a collection from the spec if none exists, or sync an existing collection that is linked to the spec
Fallbacks:
- Import API (quick trials)
- openapi-to-postman conversion for edge cases (not preferred long‑term)

Discovery sources:
- AWS API Gateway export
  - REST (v1): `aws apigateway get-export ... --export-type oas30` (supports extensions including `postman`)
  - HTTP (v2): `aws apigatewayv2 export-api ... --specification OAS30`
- Direct service endpoints (e.g., `https://<gateway-host>/openapi.json`) when available

State & Idempotency:
- Prefer resolve-by-name on every run using the naming convention to derive `specId` and `collectionUid`.
- Optionally maintain a small manifest (S3 or repo file) mapping `{api-id, stage}` → `{specId, collectionUid, lastSpecSha}`. Jobs compute a spec hash and no-op if unchanged.

Auth & Security:
- GitHub Actions uses OIDC to assume a read‑only AWS role (`apigateway:Get*`, `apigatewayv2:*Export*`), and uses `POSTMAN_API_KEY` secret to call Postman.
- No long‑lived AWS keys in CI.

Naming conventions:
- Postman API name: `[<domain>] <service> #api`
- Versions: `<stage>` or `<git tag>`; optionally append API Gateway deploymentId.
- Reference Collection: `[<domain>] <service> #reference-<stage>`

---

## 1) Proof of concept (manual/small‑scope automation)
Goal: Take 1 API (one stage) end‑to‑end into Postman.

A. Export OpenAPI from API Gateway (choose one):
- REST (v1):
  - `aws apigateway get-export --rest-api-id <REST_API_ID> --stage-name <STAGE> --export-type oas30 --parameters extensions='postman' --accepts application/json openapi.json`
- HTTP (v2):
  - `aws apigatewayv2 export-api --api-id <HTTP_API_ID> --specification OAS30 --output-type JSON --stage-name <STAGE> openapi.json`
- Or fetch directly from service (if exposed):
  - `curl -sSL https://<gateway-host>/openapi.json -o openapi.json`

B. Ingest into Postman Spec Hub and generate/sync collection
- The helper script resolves IDs by name automatically (or uses the state file) per the naming convention
- Create a Spec in the target workspace: `POST https://api.getpostman.com/specs?workspaceId=$POSTMAN_WORKSPACE_ID`
- For subsequent updates, PATCH the spec file: `PATCH https://api.getpostman.com/specs/$SPEC_ID/files/$FILE_PATH`
- Use naming: `[<domain>] <service> #api` for the Spec; collection: `[<domain>] <service> #reference-<stage>`
- Notes for PATCH /specs/:specId/files/:filePath:
  - Body must not be empty; pass exactly one property per call: `content` OR `name` OR `type`
  - Multi-file specs can only have one root; setting `type: ROOT` demotes previous root to `DEFAULT`
  - Max file size: 10 MB
- After the spec exists, generate a collection from it if none exists, or sync the existing linked collection.
  - Sync endpoint (async): `PUT https://api.getpostman.com/collections/:collectionUid/synchronizations?specId=$SPEC_ID`
  - Notes: Only supports OpenAPI 3.0; collection must have been generated from the given spec; returns 202 Accepted with a task URL you can poll.

C. Fallback (quick trial): Import API
- `curl -X POST "https://api.getpostman.com/import/openapi?workspace=$POSTMAN_WORKSPACE_ID" \
  -H "x-api-key: $POSTMAN_API_KEY" \
  -F type=file \
  -F input=@openapi.json`

D. Validate in Postman
- Confirm the Spec exists in Spec Hub, the reference collection is generated/linked, and documentation renders as expected.

E. Small‑scope automation (one API)
- A GitHub Actions workflow that exports the spec on demand and posts to Postman when manually dispatched.

---

## 2) First‑time bulk ingestion (ingest everything)
Goal: Enumerate all APIs across regions and stages; create canonical assets in Postman.

Plan:
1) Inventory
   - For each AWS region in scope, list:
     - REST APIs: `aws apigateway get-rest-apis` then `aws apigateway get-stages --rest-api-id ...`
     - HTTP APIs: `aws apigatewayv2 get-apis` then `aws apigatewayv2 get-stages --api-id ...`
   - Optionally filter via AWS tags (e.g., `postman=managed:true`) to avoid importing internal/experimental services.

2) Export + normalize
   - For each `{api, stage}`:
     - Export OAS (see commands above) to `openapi/<region>/<apiId>/<stage>.json`.
     - Normalize title/version fields if missing; compute `sha256` of the canonicalized spec.

3) Upsert into Postman (Spec Hub)
   - Create/resolve Spec → create spec version → upload content
   - Generate a collection from the spec if missing, or sync the linked collection if present
     - Sync via: `PUT /collections/:collectionUid/synchronizations?specId=$SPEC_ID` (async 202; OAS3 only; collection must be generated from that spec)
   - Naming: Use the conventions in this doc; include tags/metadata in description (region, stage, gateway IDs, source URL).

4) Map & persist state
   - Store `{region, apiType, apiId, stage} → {postmanApiUid, postmanCollectionUid, lastSpecSha}` in S3 or a repo file (`postman-ingestion-state.json`).
   - Idempotency: skip upsert when `sha` unchanged.

5) Rate limits & retries
   - Respect Postman API rate limits; backoff on 429.
   - Chunk ingestion by region; parallelize conservatively.

6) Observability
   - Emit a short summary artifact (counts created/updated/skipped), and log failures with API/stage identifiers.

Deliverable: A single GitHub Actions workflow that can be run manually for backfill and will complete the first import.

---

## 3) Keep everything up to date (ongoing sync)
Combine two mechanisms for high confidence:

A. Event‑driven updates
- GitHub:
  - Trigger ingestion on `release` and `push` to `main` for repos that own APIs. The job can either
    - export the spec directly from the app (`/openapi.json`), or
    - export via API Gateway using a known `{apiId, stage}` mapping.
  - Annotate Spec version with the git tag/commit.
- AWS (optional): EventBridge rule on API Gateway Deployment events → Lambda → call Postman ingestion (or dispatch GitHub workflow) for that `{apiId, stage}`.

B. Scheduled reconciliation
- Nightly job enumerates all APIs/stages, exports specs, computes `sha256`, and upserts only when changed.
- Keeps drift low even if an event was missed.

Versioning strategy in Postman (Spec Hub + Collections):
- Spec Hub
  - Keep one Spec entity per service (e.g., `[billing] payments #api`).
  - Create a new spec version per deployment or per git tag (e.g., `<stage>-<deploymentId>` or `<tag>`), and upload the OpenAPI content.
- Collections
  - Maintain a stable collection UID per `{service, stage}` generated from the spec; keep it linked so a sync updates it in place (no sprawl).
  - Optionally maintain a “latest” collection per service that reflects the most recent stable stage.

Notifications & traceability:
- Post a comment on GitHub releases with links to the Spec (Spec Hub) and the Collection.
- Optional: Open a GitLab issue if ingestion fails for a service, labeled with the owning team.

Rollback plan:
- Maintain previous collection revisions via Postman history. If needed, revert by re‑PUT’ing the last good collection body.
- Keep the last N exported specs in CI artifacts/S3 for quick rollback.

---

## IAM, Secrets, and Workspaces
- GitHub Actions OIDC → AWS IAM role with permissions:
  - `apigateway:GetRestApis`, `apigateway:GetStages`, `apigateway:GetExport`
  - `apigatewayv2:GetApis`, `apigatewayv2:GetStages`, `apigatewayv2:ExportApi`
- Secrets in GitHub:
  - `POSTMAN_API_KEY` (Postman API key with access to the target workspace)
  - `POSTMAN_WORKSPACE_ID` (target workspace UID)
- Optional: Multiple workspaces per environment (e.g., Sandbox/Prod) or per domain team.

## Suggested repository structure (CI/helper scripts)
- `.github/workflows/postman-oas-ingestion.yml` – workflows for POC/backfill/scheduled sync
- `scripts/export-oas.js` – exports OAS for a given `{apiId, stage, region, type}`
- `scripts/spec_sync.js` – Spec Hub helper to resolve-by-name or create, patch spec file, and sync collection (async)
- `scripts/environments_upsert.js` – upserts a Postman Environment (derive baseUrl from OpenAPI, or override)
- `state/postman-ingestion-state.json` – optional tracked mapping (or move to S3)

## Managing environments programmatically (Postman)

Naming and scope:
- One environment per service+stage (optionally region): `[<domain>] <service> #env-<stage>` or `#env-<region>-<stage>`
- Variables owned by CI: `baseUrl`, `stage`, `region` (optional), plus non-sensitive placeholders like `apiKey`, `bearerToken`

Workflow (idempotent):
1) Resolve target environment by name in workspace; if not found, create
2) Build variables from OpenAPI servers[0].url (or pass explicit `baseUrl`) + stage/region
3) Upsert via Postman API

Create environment:
```
curl -X POST "https://api.getpostman.com/environments?workspaceId=$POSTMAN_WORKSPACE_ID" \
  -H "x-api-key: $POSTMAN_API_KEY" -H "content-type: application/json" \
  -d '{"environment":{"name":"[billing] payments #env-prod","values":[
    {"key":"baseUrl","value":"https://api.acme.com/payments","type":"default","enabled":true},
    {"key":"stage","value":"prod","type":"default","enabled":true}
  ]}}'
```

Update environment:
```
curl -X PUT "https://api.getpostman.com/environments/$ENV_UID" \
  -H "x-api-key: $POSTMAN_API_KEY" -H "content-type: application/json" \
  -d @env.json
```

Validate OpenAPI with Postman CLI (fail-fast):
```
# Install CLI on Linux runners (adjust per OS)
# See Postman docs for the latest installation method
# curl -fsSL https://dl-cli.pstmn.io/install/linux | sh
postman login --with-api-key "$POSTMAN_API_KEY"
postman openapi validate openapi.json
```

Helper script usage:
```
node scripts/environments_upsert.js \
  --domain billing --service payments --stage prod --region us-east-1 \
  --openapi openapi.json
# or override baseUrl explicitly: --base-url https://api.example.com
```

GitHub Actions step (after spec sync):
```
- name: Upsert Postman environment
  env:
    POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
    POSTMAN_WORKSPACE_ID: ${{ secrets.POSTMAN_WORKSPACE_ID }}
  run: |
    node scripts/environments_upsert.js \
      --domain "${{ github.event.inputs.domain }}" \
      --service "${{ github.event.inputs.service }}" \
      --stage "${{ github.event.inputs.stage }}" \
      --region "${{ github.event.inputs.region }}" \
      --openapi openapi.json
```

---

## Example snippets

Export (REST v1):
```
aws apigateway get-export \
  --rest-api-id $REST_API_ID \
  --stage-name $STAGE \
  --export-type oas30 \
  --parameters extensions='postman' \
  --accepts application/json openapi.json
```

Export (HTTP v2):
```
aws apigatewayv2 export-api \
  --api-id $HTTP_API_ID \
  --specification OAS30 \
  --output-type JSON \
  --stage-name $STAGE openapi.json
```

Spec Hub ingest (preferred):

Create a Spec in a workspace:
```
curl -sS -X POST "https://api.getpostman.com/specs?workspaceId=$POSTMAN_WORKSPACE_ID" \
  -H "x-api-key: $POSTMAN_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "[billing] payments #api",
    "type": "OPENAPI:3.0",
    "files": [{ "path": "index.json", "content": '"'"$(cat openapi.json | jq -Rs .)"'" }]
  }'
```

Update a Spec file (one property per call):
```
curl -sS -X PATCH \
  "https://api.getpostman.com/specs/$SPEC_ID/files/index.json" \
  -H "x-api-key: $POSTMAN_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "content": '"'"$(cat openapi.json | jq -Rs .)"'" }'
```

Sync a collection with a spec (async, returns 202):
```
curl --location --request PUT \
  "https://api.getpostman.com/collections/$COLLECTION_UID/synchronizations?specId=$SPEC_ID" \
  -H "x-api-key: $POSTMAN_API_KEY"
# Response example:
# { "taskId": "...", "url": "/specs/$SPEC_ID/tasks/<taskId>" }
# Poll the returned URL if you need to wait for completion.
```
Then generate or sync a collection from the Spec using the Spec Hub collection generation/sync endpoints (invoke generate when no collection exists; sync otherwise).

Deprecated/legacy path: Import into Postman (Import API):
```
curl -X POST "https://api.getpostman.com/import/openapi?workspace=$POSTMAN_WORKSPACE_ID" \
  -H "x-api-key: $POSTMAN_API_KEY" \
  -F type=file \
  -F input=@openapi.json
```

Convert to Postman Collection (optional):
```
npx openapi2postmanv2 -s openapi.json -o collection.json --pretty -p --strict
```

Create/Update Collection:
```
# Create
curl -X POST https://api.getpostman.com/collections \
  -H "x-api-key: $POSTMAN_API_KEY" \
  -H "content-type: application/json" \
  -d @collection.json
```

Use the helper script (Spec Hub create/patch/sync):
```
node scripts/spec_sync.js \
  --domain billing \
  --service payments \
  --stage prod \
  --openapi openapi.json \
  --file-path index.json \
  --collection-uid $COLLECTION_UID \
  --state-file state/postman-ingestion-state.json \
  --poll
```


Minimal GitHub Actions (one API, manual dispatch):
```
name: Postman OAS Ingestion (POC)
on:
  workflow_dispatch:
    inputs:
      api_id: { required: true, description: 'API Gateway id (REST v1 or HTTP v2)' }
      stage: { required: true }
      region: { required: true }
      api_type: { required: true, description: 'rest|http' }
      domain: { required: true }
      service: { required: true }
      collection_uid: { required: false, description: 'Existing collection UID to sync (once generated)' }
jobs:
  ingest:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}
          aws-region: ${{ github.event.inputs.region }}
      - name: Export OpenAPI from API Gateway
        run: |
          if [ "${{ github.event.inputs.api_type }}" = "rest" ]; then
            aws apigateway get-export \
              --rest-api-id "${{ github.event.inputs.api_id }}" \
              --stage-name "${{ github.event.inputs.stage }}" \
              --export-type oas30 \
              --parameters extensions='postman' \
              --accepts application/json openapi.json;
          else
            aws apigatewayv2 export-api \
              --api-id "${{ github.event.inputs.api_id }}" \
              --specification OAS30 \
              --output-type JSON \
              --stage-name "${{ github.event.inputs.stage }}" openapi.json;
          fi
      - name: Spec Hub create/patch and optional sync
        env:
          POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
          POSTMAN_WORKSPACE_ID: ${{ secrets.POSTMAN_WORKSPACE_ID }}
        run: |
          EXTRA=""
          if [ -n "${{ github.event.inputs.collection_uid }}" ]; then
            EXTRA="--collection-uid ${{ github.event.inputs.collection_uid }}"
          fi
          node scripts/spec_sync.js \
            --domain "${{ github.event.inputs.domain }}" \
            --service "${{ github.event.inputs.service }}" \
            --stage "${{ github.event.inputs.stage }}" \
            --openapi openapi.json \
            --file-path index.json \
            $EXTRA \
            --state-file state/postman-ingestion-state.json \
            --poll
```

---

## Risks and mitigations
- Spec validity: Validate the OpenAPI with Postman CLI before ingestion to catch issues that would block import or cause quirks.
- Rate limits: Add backoff/retries and chunked ingestion.
- Duplicates: Enforce naming + state mapping; update existing assets instead of creating new ones.
- Secrets: Use OIDC for AWS; restrict Postman API key to necessary workspaces.

## Timeline (suggested)
- Week 1: POC for one API/stage, sign‑off on naming/structure
- Week 2: Bulk backfill (read‑only dry run, then live)
- Week 3: Wire event‑driven updates + nightly reconciliation, add notifications

## Success criteria
- 100% of in‑scope APIs visible in Postman with correct naming and metadata
- Subsequent deployments reflected in Postman within minutes (event‑driven) or <24h (reconciliation)
- Zero duplicate canonical collections; stable links for consumers

