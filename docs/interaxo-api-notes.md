# Interaxo API notes

Behavior of the Interaxo (Tribia) REST API as implemented by this package. The official
reference is https://api.interaxo.com/ (HTML only — there is no machine-readable OpenAPI
spec). Everything below has been verified against a live environment; rules the official
docs do not mention are marked **(observed)**.

## Hosts

| Host | Role |
|---|---|
| `https://api.interaxo.se` / `https://api.interaxo.com` | Primary REST API (`/v1/...`) |
| `https://login.collaboration-sso.com/oauth/token` | Auth0 token endpoint |
| `https://api.interaxo.com/v1/` | OAuth **audience** value only |
| `https://ix.interaxo.se` | Legacy host: version history, version revert, pre-signed downloads |

## Authentication

OAuth2 client_credentials (machine-to-machine):

```
POST {tokenUrl}
  grant_type=client_credentials, client_id, client_secret, audience=https://api.interaxo.com/v1/
→ { access_token, expires_in ≈ 3600 }
```

Every request sends `Authorization: Bearer <token>` and `X-Requested-With: XMLHttpRequest`.
Tokens should be cached until expiry — Auth0 M2M grant quotas are the practical rate limit;
the API itself exposes no documented limits **(observed)**.

## Content model

Tree nodes are heterogeneous; traversal must branch on `type`:

- `simple-folder` — plain folder (the *search filter* value for it is `folder`; filtering by
  `simple-folder` returns 404 **(observed)**)
- `active-folder` — holds `entry` children; carries the `fields[]` schema
- `workflow-folder` — active-folder plus `steps[]` (review states); entries carry `step {id, name}`
- `entry` — metadata record; files attach as children
- `file` — binary; `parent_id` points at its entry; has a pre-signed `content_url`

## Endpoints used

| Op | Method + path |
|---|---|
| List communities | `GET /v1/communities` |
| List rooms | `GET /v1/{community}/rooms` |
| Get room | `GET /v1/{community}/rooms/{room}` → `content.root_id` is the tree entry point |
| Get item | `GET .../content/{id}` |
| List children | `GET .../content/{id}/children?limit=&skip=` → bare JSON array |
| Search (recursive) | `GET .../content/{id}/search?type=&name=&limit=&skip=` — `name` supports glob |
| Delete item | `DELETE .../content/{id}` → 204 |
| Upload new attachment | `POST .../content/{entryId}/children` — multipart, field `file` |
| Upload new version | `POST .../files/{fileId}/versions` — multipart, field `file` |
| Create entry | `POST .../content/{folderId}/children` — `{type: "entry", fields: [...]}` |
| Move entry between steps | `POST .../content/{folderId}/steps/{stepId}` — body is the **entry id as a bare JSON string** → 204 |
| Version history | `GET https://ix.interaxo.se/v1/{community}/ix/nodes/{fileId}/versions?roomId=&nodeId=&expand=authorities&limit=&start=` |
| Revert version | `POST https://ix.interaxo.se/api/{community}/rooms/{room}/documents/file/{fileId}/revert` — `{major, comment, versionLabel}` |
| Download | `GET {content_url}` — pre-signed; send **no** Authorization header |

## Behavior rules

- **Pagination:** `limit` + `skip`, responses are bare arrays with no total count. Stop when
  a page is shorter than `limit`. Page sizes up to 500 work fine.
- **404 from `/search`** below an empty folder means "no results", not an error **(observed)**.
- **Room addressing is ambiguous** — the API accepts both the room slug and the content-root
  UUID in the `{room}` position **(observed)**.
- **Upload semantics:** to attach a file, list the entry's children and match the file name
  case-insensitively — a match means POST a new *version*, otherwise POST a new *attachment*.
- **Search results and postable folders:** search returns files whose parent is an entry;
  walk `parent_id` upward to reach an `active-folder`/`workflow-folder` before creating entries.

## Entry creation rules (observed — the API only answers with an opaque `validation_error`)

- Field definitions come from `GET /content/{folderId}` → `fields[]`
  (`{id, name, type, mandatory, read_only, multiple, options}`). Post values as
  `{id, type, value}` using the schema's `id` — a UUID in some folders, a logical id
  (e.g. `phentry:list4`) in template-based folders.
- **Every mandatory field must be sent.**
- Drop `auto-number` and `read_only` fields, and empty non-mandatory fields.
- **List values must be arrays even for single-select lists** (`"value": ["A"]`).
- Omit `step` — entries are created in the workflow's initial step; sending a step
  explicitly often trips step-specific validation.

## Workflow step rules (observed)

- Transitions appear **forward-only**: moving an entry back to an earlier step returned
  HTTP 500.
- API clients can **delete entries only while they are in the initial step** — deletes in
  later steps return 403. Deleting an entry cascades to its file attachments.
