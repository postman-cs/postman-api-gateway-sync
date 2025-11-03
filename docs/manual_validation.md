## 1\) Proof of concept (manual/small‑scope automation)

**Goal:** Take 1 API (one stage) end‑to‑end into Postman.

**Status:** Validated during initial pilot session. See [session_walkthrough.md](./session_walkthrough.md) for complete guide.

---

### Lessons Learned (Initial Validation Session)

#### What Worked
- AWS API Gateway v2 (HTTP API) export via AWS CLI successfully exported OpenAPI 3.0 spec
- Created test workspace in Postman UI
- Generated Postman API key
- Identified correct API Gateway types (HTTP v2 vs REST v1)

#### Challenges Encountered
1. **Manual curl commands unreliable**: Encoding errors and authentication issues (403 Forbidden) when using curl to POST to Postman API
2. **API Gateway type confusion**: Initially tried REST API commands on HTTP v2 APIs (WebSocket)
3. **Stage identifier issues**: Required exact stage names from `get-stages` command
4. **JSON escaping complexity**: Manual curl with heredocs and JSON escaping proved error-prone

#### Resolution
**Use Node.js helper scripts instead of manual curl commands**. The scripts (`spec_sync.js` and `environments_upsert.js`) handle:
- Proper JSON serialization
- Authentication headers
- Error handling and retries
- State management for idempotency
- Async polling for sync tasks

---

### A. Export OpenAPI from API Gateway (choose one):

**First, identify your API type:**
```bash
# Check for HTTP APIs (v2)
aws apigatewayv2 get-apis

# Check for REST APIs (v1)
aws apigateway get-rest-apis
```

- **HTTP (v2)** - Most common for Lambda-backed APIs:  
  ```bash
  aws apigatewayv2 export-api \
    --api-id <HTTP_API_ID> \
    --specification OAS30 \
    --output-type JSON \
    --stage-name <STAGE> \
    openapi.json
  ```

- **REST (v1)**:  
  ```bash
  aws apigateway get-export \
    --rest-api-id <REST_API_ID> \
    --stage-name <STAGE> \
    --export-type oas30 \
    --parameters extensions='postman' \
    --accepts application/json \
    openapi.json
  ```

- **Or fetch directly from service** (if exposed):  
  ```bash
  curl -sSL https://<gateway-host>/openapi.json -o openapi.json
  ```

**Tip**: List APIs and stages first to identify your API type:
```bash
# HTTP APIs (v2)
aws apigatewayv2 get-apis
aws apigatewayv2 get-stages --api-id <API_ID>

# REST APIs (v1)
aws apigateway get-rest-apis
aws apigateway get-stages --rest-api-id <REST_API_ID>
```

**If you get a "NotFoundException"**, try the other API type - your API might be HTTP v2 instead of REST v1 (or vice versa).

---

### B. Ingest into Postman Spec Hub and generate/sync collection

**RECOMMENDED: Use the Node.js helper scripts**

```bash
# Set environment variables
export POSTMAN_API_KEY="your-api-key"
export POSTMAN_WORKSPACE_ID="your-workspace-id"

# Sync spec and collection
node scripts/spec_sync.js \
  --domain <domain> \
  --service <service> \
  --stage <stage> \
  --openapi openapi.json \
  --file-path index.json \
  --state-file state/postman-ingestion-state.json \
  --poll
```

**What the script does:**
- Resolves IDs by name automatically (or uses the state file) per the naming convention  
- Creates a Spec in the target workspace: `POST https://api.getpostman.com/specs?workspaceId=$POSTMAN_WORKSPACE_ID`  
- For subsequent updates, PATCHes the spec file: `PATCH https://api.getpostman.com/specs/$SPEC_ID/files/$FILE_PATH`  
- Uses naming: `[<domain>] <service> #api` for the Spec; collection: `[<domain>] <service> #reference-<stage>`  
- After the spec exists, generates a collection from it if none exists, or syncs the existing linked collection
  - Sync endpoint (async): `PUT https://api.getpostman.com/collections/:collectionUid/synchronizations?specId=$SPEC_ID`  
  - Only supports OpenAPI 3.0; collection must have been generated from the given spec; returns 202 Accepted with a task URL you can poll

**Important notes:**
- Body must not be empty; pass exactly one property per call: `content` OR `name` OR `type`  
- Multi-file specs can only have one root; setting `type: ROOT` demotes previous root to `DEFAULT`  
- Max file size: 10 MB  
- First-time setup: Generate the collection manually in Postman UI, then rerun the script to sync

---

### C. Create Postman Environment

**Use the environments helper script:**

```bash
node scripts/environments_upsert.js \
  --domain <domain> \
  --service <service> \
  --stage <stage> \
  --region <region> \
  --openapi openapi.json
```

Creates/updates an environment with:
- `baseUrl`: Extracted from OpenAPI `servers[0].url`
- `stage`, `region`: From command-line flags
- `apiKey`, `bearerToken`: Empty placeholders

---

### D. Validate in Postman

- Confirm the Spec exists in Spec Hub, the reference collection is generated/linked, and documentation renders as expected
- Check that environment variables are set correctly
- Test a request using the environment

---

### E. Small‑scope automation (one API)

- A GitHub Actions workflow that exports the spec on demand and posts to Postman when manually dispatched
- See complete automation guide in [POSTMAN_OAS_INGESTION_PROPOSAL.md](./POSTMAN_OAS_INGESTION_PROPOSAL.md)

---

## Additional Resources

- **[session_walkthrough.md](./session_walkthrough.md)** - Comprehensive 60-minute walkthrough with detailed steps, troubleshooting, and validation
- **[quick_reference.md](./quick_reference.md)** - One-page cheat sheet with all commands and troubleshooting matrix
- **[scripts/preflight_check.js](./scripts/preflight_check.js)** - Pre-session validation script to check all prerequisites
- **[POSTMAN_OAS_INGESTION_PROPOSAL.md](./POSTMAN_OAS_INGESTION_PROPOSAL.md)** - Complete automation proposal and architecture