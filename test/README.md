# Test instance

Isolated n8n (pinned to the production version, currently 2.8.3) for testing the custom node.
Runs on **http://localhost:5679** with its own data dir — completely separate from any
production n8n on the machine.

## Start

```bash
cp test/.env.example test/.env   # then set N8N_ENCRYPTION_KEY (openssl rand -hex 24)
docker compose -f test/docker-compose.yml --env-file test/.env up -d
```

First visit creates the owner account (or create it headlessly via
`POST /rest/owner/setup {email, firstName, lastName, password}`).

The built `dist/` is mounted read-only as a custom extension — the node appears as
type `CUSTOM.interaxo`. After changing code:

```bash
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/home/node/pkg -w /home/node/pkg node:22-alpine npx n8n-node build
docker restart n8n-interaxo-test
```

## Test workflows

`workflows/*.json` — tests 1–3 are **read-only** (search, get, versions, field schema,
download). Tests 4–6 **write to Interaxo** (create entry, upload, move step, delete) and are
self-cleaning, but only run them against a folder you are allowed to test in — replace the
placeholder community/room/folder IDs with your own before running. Import them in the UI, pin an `Interaxo API` credential
onto the nodes, and run.

Headless execution (the CLI needs non-conflicting ports inside the container):

```bash
docker exec -e N8N_RUNNERS_ENABLED=false -e N8N_RUNNERS_BROKER_PORT=5699 -e N8N_PORT=5698 n8n-interaxo-test n8n execute --id <workflowId>
```

Note: n8n's REST API requires a `browser-id` header on every request in addition to the
session cookie (any constant string works, but it must be the same one used at login).

## Verified against the live API (2026-08-19, n8n 2.8.3)

Read operations:

- Credential: client_credentials token fetch via preAuthentication, cached expirable token
- Community Get Many, Room Get Many (resourceLocator, slug + id modes)
- Content Search (glob `*.ifc`/`*.pdf`, type filter, limit), Get, Resolve Parent Folder
- Entry Get Field Schema (fields + steps)
- File Get Versions (ix host), Download (pre-signed content_url → binary, correct name/mime/size)

Write operations (all against temporary self-created entries, cleaned up afterwards):

- Entry Create — schema-resolved field IDs, all-mandatory check, list values array-wrapped
- File Upload — both branches: new attachment (v1.0) and new version by basename match (v2.0)
- Entry Move to Step — `POST .../content/{folderId}/steps/{stepId}` with entry ID as JSON-string body
- Content Delete — entries and files (entry delete cascades to attachments)

Not exercised: File Revert Version (ix host endpoint, code follows the production service).

API rules discovered during write testing (also in PLAN.md):

- Every mandatory folder field must be sent on entry create, or the API returns an
  opaque `validation_error` — the node checks this client-side and names the missing fields
- List-type field values must be arrays even for single-select lists
- Entries are only deletable by the API client while in the **initial** workflow step
- Step transitions appear **forward-only** — moving an entry backwards returned HTTP 500,
  which can strand a test entry where the API cannot delete it (UI deletion still works)
- One n8n gotcha: a delete node fed multiple input items runs once per item — the second
  run 404s on the already-deleted ID. Set "Execute Once" on delete nodes in test flows.
