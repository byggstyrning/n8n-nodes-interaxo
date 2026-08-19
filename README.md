# n8n-nodes-interaxo

n8n community nodes for [Interaxo](https://interaxo.com) (Tribia) — the collaboration and
document-management platform used in Nordic construction projects.

Covers communities, rooms, the content tree (folders / active-folders / workflow-folders /
entries / files), file upload with automatic create-or-new-version handling, downloads via
pre-signed content URLs, version history, and entry creation with schema-aware field
sanitization.

See [PLAN.md](PLAN.md) for the full design, the API surface, and the production conventions
this package is built on.

## Nodes

### Interaxo

| Resource | Operations |
|---|---|
| Community | Get Many |
| Room | Get, Get Many |
| Content | Get, List Children, Search (recursive, glob + type + workflow-step filters), Delete, Resolve Parent Folder |
| File | Upload (create-or-version), Download, Get Versions, Revert Version |
| Entry | Create (schema-aware field sanitization), Get Field Schema, Move to Step |

Planned: **Interaxo Trigger** — scheduled polling for new/changed files (Interaxo has no webhooks).

## Credentials

Create an **Interaxo API** credential with the OAuth2 machine-to-machine client ID and secret
issued by Tribia (apply at [interaxo.com/api-integration](https://interaxo.com/sv/api-integration/)).
Token URL, audience and base URLs default to the production Swedish region and rarely need
changing. Tokens are fetched via client_credentials and cached by n8n until expiry.

## Development

The full API reference lives at https://api.interaxo.com/ (HTML only, no OpenAPI spec).

```bash
npm ci
npm run build
npm run lint
```

On a machine without Node.js, run the toolchain through Docker:

```bash
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/home/node/pkg -w /home/node/pkg node:22-alpine npm ci
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/home/node/pkg -w /home/node/pkg node:22-alpine npx n8n-node build
```

Note: mount the repo at least two directories below `/` (as above) — the community-nodes
lint plugin never checks package.json at depth one, which makes its credential check
report a false positive.

To test in a running n8n container, mount `dist/` into the container's custom-extensions
directory (`~/.n8n/custom/` or a path listed in `N8N_CUSTOM_EXTENSIONS`) and restart n8n.

## License

[MIT](LICENSE.md)
