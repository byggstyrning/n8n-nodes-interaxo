# n8n-nodes-interaxo

This is an n8n community node. It lets you use **Interaxo** in your n8n workflows.

[Interaxo](https://interaxo.com) (by Tribia) is a collaboration and document-management
platform widely used in Nordic construction projects — rooms hold a content tree of folders,
metadata entries and file attachments, with review workflows on top.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/)
in the n8n community nodes documentation. The package name is `n8n-nodes-interaxo`.

## Operations

### Interaxo node

| Resource | Operation | Notes |
|---|---|---|
| Community | Get Many | Communities the credential can access |
| Room | Get | Includes `content.root_id`, the entry point of the room's content tree |
| Room | Get Many | |
| Content | Get | Any content item (folder, entry, file) by ID |
| Content | List Children | Direct children, paginated |
| Content | Search | Recursive search below a folder — name glob (`*.ifc`), type filter, workflow-step filter, Return All |
| Content | Resolve Parent Folder | Walks parent IDs up to the nearest active-folder / workflow-folder (the only types entries can be created in) |
| Content | Delete | Entries and files; deleting an entry removes its attachments |
| Entry | Create | Schema-aware: resolves field IDs from the folder schema by display name, validates mandatory fields client-side, wraps list values correctly |
| Entry | Get Field Schema | Field definitions and workflow steps of a folder |
| Entry | Move to Step | Move an entry between workflow steps |
| File | Upload | Create-or-version: same file name on the entry ⇒ new version, otherwise new attachment |
| File | Download | Streams via the file's pre-signed content URL into binary data |
| File | Get Versions | Version history including uploader identities |
| File | Revert Version | Re-instate an earlier version as a new version |

The node is marked usable as a tool for n8n AI agents.

## Credentials

You need an OAuth2 **machine-to-machine client** (client ID + secret) for the Interaxo API.
Apply for API access at [interaxo.com/api-integration](https://interaxo.com/sv/api-integration/) —
Tribia provisions credentials, documentation and sandbox access.

Create an **Interaxo API** credential in n8n with the client ID and secret. The remaining
fields (token URL, audience, API base URLs) default to the production environment and rarely
need changing. The node fetches tokens via the client-credentials grant and caches them until
expiry, keeping pressure off the Auth0 M2M quota.

## Compatibility

Developed and tested against n8n 2.8.3 (self-hosted). No runtime dependencies.

## Usage

A few Interaxo behaviors worth knowing:

- **Room addressing:** rooms can be addressed by slug or by content-root UUID; the room
  selector accepts both, or pick from the list.
- **Entry create:** every mandatory field of the target folder must be provided — the node
  checks this before posting and names any missing fields (the API itself only returns an
  opaque `validation_error`). Fields may be given by display name; IDs and types are resolved
  from the folder schema.
- **Workflow steps:** new entries always start in the folder's initial step. Step transitions
  are typically forward-only, and the API can delete entries only while they are in the
  initial step — plan flows accordingly.
- **Upload semantics:** uploads target an *entry*; a case-insensitive file-name match against
  existing attachments decides between "new version" and "new attachment".
- **Search:** a 404 from a search below an empty folder is returned as an empty result, not
  an error.

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
* [Interaxo API reference](https://api.interaxo.com/)
* [Interaxo API access](https://interaxo.com/sv/api-integration/)

## Version history

* **0.1.0** — initial release: Community, Room, Content, Entry and File resources; OAuth2
  client-credentials credential with token caching. All read and write operations verified
  against a live Interaxo environment.

## Development

```bash
npm ci
npm run build
npm run lint
```

On a machine without Node.js, the same toolchain runs through Docker:

```bash
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/home/node/pkg -w /home/node/pkg node:22-alpine npm ci
docker run --rm -u 1000:1000 -e HOME=/tmp -v "$PWD":/home/node/pkg -w /home/node/pkg node:22-alpine npx n8n-node build
```

(Mount the repo at least two directories below `/` — the community-nodes lint plugin's
package.json lookup skips depth-one paths.)

`test/` contains a docker-compose for an isolated n8n instance with the built package
mounted as a custom extension, plus live-API test workflows — see [test/README.md](test/README.md).

Releases are published to npm via GitHub Actions with provenance on version-tag pushes
(`npm run release` locally to lint, build, bump, tag and push).
