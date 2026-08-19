# n8n-nodes-interaxo — Design Plan

Community node package for **Interaxo** (Tribia collaboration/DMS used in Nordic construction projects).
The design below is reverse-engineered from the production integration running on this machine
(ifcpipeline dashboard service, 12 live n8n workflows, standalone Python/JS clients) — every endpoint
and quirk listed here is in active use, not speculation.

## 1. Why

The same Interaxo client is currently implemented **three times** on this machine:

1. `ifcpipeline/dashboard/services/interaxo_service.py` (~2500 lines, canonical: token cache, search, upload, versions, entries)
2. ~10 n8n workflows with inline Code nodes re-implementing token fetch + tree traversal each time
3. Standalone scripts (`INTERAXO/trigger_process_rvt.py`, `condensed-ids/code_*.js`)

The n8n side already factored the common operations into four sub-workflows — these map ~1:1 onto
the node operations and are the primary replacement target:

| Existing sub-workflow | Executions | Replaced by |
|---|---:|---|
| `Subflow: Interaxo Search` | 8752 | Content → Search / List Children (+ room resolution, step filter) |
| `Subflow: Interaxo Upload` | — | File → Upload (auto create-or-new-version) |
| `Subflow: Interaxo Download` | — | File → Download |
| `Subflow: Get Interaxo Token` | — | Credential (`preAuthentication`, expirable token) |
| `Poll for RVT changes` | 1008 | **Interaxo Trigger** node (scheduled poll + diff) |

## 2. API facts (as used in production)

### Hosts
| Host | Role |
|---|---|
| `https://api.interaxo.se` | Primary REST API (`/v1/...`) — all content operations |
| `https://login.collaboration-sso.com/oauth/token` | Auth0 token endpoint |
| `https://api.interaxo.com/v1/` | OAuth **audience** string only, never called |
| `https://ix.interaxo.se` | Legacy/UI host: version history, version revert, deep links, pre-signed downloads |

### Auth
OAuth2 **client_credentials** (M2M). No user login, no refresh token.

```
POST {tokenUrl}  (form-urlencoded or JSON)
  grant_type=client_credentials, client_id, client_secret, audience=https://api.interaxo.com/v1/
→ { access_token, expires_in≈3600 }
```

Every request: `Authorization: Bearer <token>` + `X-Requested-With: XMLHttpRequest` (always sent; assume required).

Token handling in the node package: credential `preAuthentication` with an **expirable** hidden
`sessionToken` property → n8n caches the token per credential and re-runs preAuth on expiry/401.
This also protects the Auth0 M2M grant quota (the real rate limit in practice — the API itself has
no observed 429s).

### Content model
Tree nodes are heterogeneous — traversal must branch on `type`:

- `folder` — plain folder; use `/search` for recursive find
- `active-folder` — holds `entry` children; carries the `fields[]` schema
- `workflow-folder` — like active-folder + `steps[]` (review states); entries carry `step {id,name}`
- `entry` — metadata record ("document"); files attach as children
- `file` — binary; `parent_id` → its entry; has `content_url` (pre-signed, embedded JWT)

### Endpoints
| Op | Method + path |
|---|---|
| List communities | `GET /v1` |
| List rooms | `GET /v1/{community}/rooms` |
| Get room | `GET /v1/{community}/rooms/{room}` → `content.root_id` is the tree entry point |
| Root content | `GET .../rooms/{room}/content?limit=` |
| Get item | `GET .../content/{id}` (`?version=` optional) |
| List children | `GET .../content/{id}/children?limit=&skip=` → **bare array** |
| Search (recursive) | `GET .../content/{id}/search?type=&name=&limit=&skip=` — `name` supports glob (`*.ifc`); **404 ⇒ empty** |
| Delete item | `DELETE .../content/{id}` → 204 |
| Upload new attachment | `POST .../content/{entryId}/children` — multipart, field **`file`** |
| Upload new version | `POST .../files/{fileId}/versions` — multipart, field **`file`** |
| Create entry | `POST .../content/{folderId}/children` — JSON `{type:"entry", fields:[{id,type,value}], step?}`; parent must be `active-folder`/`workflow-folder` |
| Version history | `GET https://ix.interaxo.se/v1/{community}/ix/nodes/{fileId}/versions?roomId=&nodeId=&expand=authorities&limit=100&start=0` (`created` = epoch ms) |
| Revert version | `POST https://ix.interaxo.se/api/{community}/rooms/{room}/documents/file/{fileId}/revert` — `{major, comment, versionLabel}` |
| Download | `GET {content_url}` — pre-signed on `ix` host; **send NO Authorization header**; stream, 300 s timeout |

### Conventions (all battle-tested in the Python service)
- **Pagination:** `limit` + `skip`, bare JSON array, no total/cursor. Loop: `if len(page) < limit: break; skip += len(page)`. Production page size 500 (200 for plain children listing).
- **404 on `/search` = empty result**, not an error.
- **401 ⇒ invalidate token, retry exactly once** (n8n does this automatically with expirable preAuth credentials).
- Self-imposed politeness throttle in workflows: ~50 ms between calls — expose as node option.
- Timeouts: 15 s default, 60 s tree ops, 300 s downloads.
- **Room id is ambiguous** (slug like `mall-projektering` vs root UUID). Resolution fallback chain: direct GET → match `id`/`content.root_id` in room list → match display name. Solve with a **resourceLocator** (From List / By Slug / By ID).
- **Upload pattern (universal):** list entry children → case-insensitive basename match → exists ⇒ `POST /files/{id}/versions`, else ⇒ `POST /content/{entryId}/children`.
- **Parent walking:** search returns files whose parent is an *entry*, not a postable folder. Walk `parent_id` upward (max ~48 hops, cycle-detect) to the nearest `active-folder`/`workflow-folder`.
- Deep link for humans: `https://ix.interaxo.se/{community}/{room}/documentLibrary/{id}`.
- `ix` authority strings encode user+community: `name~domain@community` (`~` is a literal `@`).

### Entry fields (create) — hard-won rules
- Field defs come from the parent folder: `GET /content/{folderId}` → `fields[]` (`{id, name, type, mandatory, read_only, multiple}`). Post values as `{id: <field-uuid>, type, value}` — **uuid, not display name**.
- **Drop** `auto-number` fields, `read_only` fields, and non-mandatory fields with empty values (all cause `validation_error`).
- `multiple: true` fields take an **array** value.
- **Omit `step` on create** — Interaxo defaults to the initial workflow step; sending one explicitly often triggers validation errors.
- Real-world field names (KVA Trelleborg): `NAMN` (identity key — filename stem must equal `NAMN` for uploads), `BESKRIVNING`, `05.DOKUMENTTYP`, `STATUS`, `REV. BETECKNING`, `DATUM`, `01.DELPROJEKT`, `02.ETAPP`, `03.BYGGNAD`, `04.DISCIPLIN`, `06.VÅNING`, `07.SKEDE`, `08.PM`.

## 3. Package design

### Credential: `interaxoApi`
Fields: Client ID, Client Secret (password), Token URL (default `https://login.collaboration-sso.com/oauth/token`),
Audience (default `https://api.interaxo.com/v1/`), API Base URL (default `https://api.interaxo.se`),
IX Base URL (default `https://ix.interaxo.se`). Hidden expirable `sessionToken` via `preAuthentication`.
Credential test: `GET {apiUrl}/v1`.

### Node: `Interaxo` (resource → operation)

| Resource | Operations | Notes |
|---|---|---|
| **Community** | Get Many | |
| **Room** | Get Many, Get | Get returns `content.root_id`; room param is a resourceLocator everywhere |
| **Content** | Get, List Children, Search, Delete, Resolve Parent Folder | Search: type filter, name glob, step-name filter for workflow-folder entries, returnAll |
| **File** | Upload, Download, Get Versions, Revert Version | Upload = auto create-or-version with basename match; Download follows `content_url` unauthenticated |
| **Entry** | Create, Get Field Schema, Move to Step, Find by Field | Create with dynamic fields UI backed by the folder's `fields[]` (loadOptions); sanitization rules from §2; Move to Step via documented `POST /content/{entryId}/{stepId}` |

All list operations: `returnAll` toggle + limit, shared paginated fetch helper.
`usableAsTool: true` so it works with AI agents.

### Node: `Interaxo Trigger` (phase 2)
Scheduled poll (Interaxo has no webhooks): search under a folder for files matching a glob,
diff `last_modified`/`version` against `workflowStaticData`, emit new/changed files.
Replaces `Poll for RVT changes` (1008 executions).

### Layout (mirrors current n8n-nodes-starter conventions)
```
credentials/InteraxoApi.credentials.ts
nodes/Interaxo/Interaxo.node.ts
nodes/Interaxo/shared/transport.ts        # apiRequest, apiRequestAllItems, ixRequest
nodes/Interaxo/shared/descriptions.ts     # community/room/content locators
nodes/Interaxo/listSearch/*.ts            # getCommunities, getRooms
nodes/Interaxo/resources/{community,room,content,file,entry}/
icons/interaxo.svg
```

## 4. Dev workflow on this machine

No local Node.js — use Docker (same as everything else here):

```bash
docker run --rm -u 1000:1000 -e HOME=/tmp -v ~/n8n-nodes-interaxo:/home/node/pkg -w /home/node/pkg node:22-alpine npm ci
docker run --rm -u 1000:1000 -e HOME=/tmp -v ~/n8n-nodes-interaxo:/home/node/pkg -w /home/node/pkg node:22-alpine npx n8n-node build
docker run --rm -u 1000:1000 -e HOME=/tmp -v ~/n8n-nodes-interaxo:/home/node/pkg -w /home/node/pkg node:22-alpine npx n8n-node lint
```

(Mount at least two directories below `/` — the lint plugin's package.json lookup skips
depth-one paths and falsely reports the credential as foreign.)

Test in the live n8n: mount the built package into the ifcpipeline n8n container as a custom
node (`~/.n8n/custom/` inside the container, or `N8N_CUSTOM_EXTENSIONS`), then restart n8n.

## 5. Public footprint (researched 2026-08-19)

- **Official docs exist and cover the full v1 surface**: https://api.interaxo.com/ (Slate-style HTML,
  no machine-readable OpenAPI spec — local copy in `reference/interaxo-api-docs.html`, gitignored).
  The same page is served as catch-all on `api.interaxo.se`. 33 documented operations. Everything we
  use locally is documented, plus these we *don't* use yet:
  - **`POST .../content/{entry_id}/{step_id}` — move entry between workflow steps** (closes the
    step-transition gap; implemented as Entry → Move to Step)
  - `GET /files/{id}/content` — documented authenticated download (alternative to pre-signed `content_url`),
    plus `/thumbnail`, `/preview`, `/versions` on the api host
  - `PUT /content/{id}` (update), `PATCH rooms/{room}` (lock/unlock), `GET /content/{id}/files?name=`
  - Comments CRUD (`/content/{id}/comments[/{commentId}]`, `mentionable-authorities`)
  - People: `GET /{community}/people/{id}`, `/groups`; `GET /{community}/workspaces`
  - Jobs: `POST /jobs/content-exports` (CSV of active folders/entries), room exports (`jobs:room-exports`
    token permission, billed separately), `GET /jobs/{id}/content`
  - Query params: `sort` (`-` prefix descending), `include=permissions`
- **Auth details confirmed**: Auth0 EU tenant behind `login.collaboration-sso.com`; client_credentials
  with the `.com` audience is the documented M2M flow. Redirect/user flow + `offline_access` exist for
  user-context integrations (offline tokens 30 days, refresh tokens 30 min). Tribia provides **sandbox
  access** with API approval (interaxo.com/sv/api-integration/, 1–2 business days).
- **No client library, SDK, Postman collection or n8n node exists anywhere public.** The only public
  Interaxo client code on GitHub is our own ifcpipeline example workflow. `n8n-nodes-interaxo` is free
  on npm — this package would be first of its kind.
- **BIMeye** (Tribia's BIM data product) has a real OpenAPI 2.0 spec on SwaggerHub
  (`simon-blom/services-bim_data` — local copy `reference/bimdata-swagger.json`); candidate for a
  future separate resource/node if BIM Data access is needed.
- **No rate limits documented**; no webhooks/event subscriptions — triggers must poll.

## 6. Remaining open questions

- Whether `X-Requested-With` is truly required (kept: harmless, always sent in production).
- Whether the documented `GET /files/{id}/content` streams as reliably as the pre-signed
  `content_url` for multi-hundred-MB IFC files (production uses `content_url` with 300 s timeout).
- Entry custom-field schema behaviors beyond the doc examples (our §2 sanitization rules stay
  the authority — they encode production experience the docs lack).

## 7. Milestones

1. **v0.1** — credential + Community/Room/Content read ops (covers the 8752-execution search subflow)
2. **v0.2** — File upload/download/versions, Entry create with dynamic fields
3. **v0.3** — Interaxo Trigger (poll + diff), revert/delete admin ops
4. **v0.4** — swap the live workflows over to the node package, retire the inline Code-node clients
