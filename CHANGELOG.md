# Changelog

## 0.1.3

- **File → Find** (new): find files below a folder, a path, a workflow step or an entry by
  exact name or glob. Optional filters: workflow step, entry name (exact or glob), modified
  after. Adds the parent entry's `entry_id`, `entry_name`, `entry_step`, `entry_step_id` and,
  on request, its field values as `entry_fields`. Output as one item per file or as a single
  `{found, count, files, location}` summary item that is always emitted. Uses one recursive
  search request instead of walking entries.
- **Content → Get by Path** (new): resolve `/Folder/…/Workflow folder/Step/Entry/file` to the
  item, including a step segment below workflow folders; exact match first, then
  case-insensitive, never ambiguous.
- **Content → Search: name filter now matches exactly.** The API's `name` parameter is a loose
  prefix match, so `A-40-V-0001` also returned `A-40-V-0001_Part2` and other siblings; results
  are now re-checked client-side (exact or `*`/`?` glob, case-insensitive). Searches without a
  name filter are unchanged.
- **Rooms given as content-root UUID now work everywhere.** `GET /rooms/{room}` only accepts
  the slug, so Room → Get, Content → Search (no folder) and the new operations fall back to
  matching the room list by slug, root UUID or name.
- **File → Upload: "Upload To" and "If No File With That Name"** (new options). Upload To =
  Existing File adds a new version to a given file ID. For uploads to an entry, "If No File With
  That Name" chooses between adding a new attachment (default, unchanged), skipping
  (`{uploadMode: "skipped", existingFiles}`) or failing the item.
- **Clearer API errors.** Interaxo's own `code: message` and field errors are shown instead of
  n8n's generic "Bad request" text, and the HTTP status is kept on the error.
- Rooms given as content-root UUID: the room list is cached per community for 10 minutes, so
  repeated items don't pay a 404 + list request each. File → Find's `location` gains `parent_id`.
- `scripts/dev/`: Docker-only build/lint, deploy to a test or local n8n, workflow round-trip.

## 0.1.2

- **File → Upload: fix memory leak and lower peak RAM** (#9). The multipart body is now
  built as a plain Buffer instead of WHATWG `Blob` + `FormData`. On Node < 24.20 the
  old path leaked one full copy of every uploaded file until the n8n process restarted
  (nodejs/node#63574, `Blob.prototype.stream()`), and it peaked at ~3.3x the file size;
  the new path retains nothing and peaks at ~2.3x. Wire format unchanged (field `file`,
  filename and Content-Type as before); no new dependencies.

## 0.1.1

- First release published via GitHub Actions with npm provenance (OIDC Trusted Publishing); no functional changes

## 0.1.0

Initial release.

- **Interaxo node** with five resources: Community (Get Many), Room (Get, Get Many),
  Content (Get, List Children, Search, Resolve Parent Folder, Delete), Entry (Create,
  Get Field Schema, Move to Step), File (Upload, Download, Get Versions, Revert Version)
- **Interaxo API credential**: OAuth2 client-credentials with expirable cached session token
- Schema-aware entry creation: field-ID resolution by display name, client-side
  mandatory-field validation, list-value array wrapping
- Create-or-version upload semantics, pre-signed-URL downloads, ix-host version history
- All read and write operations verified against a live Interaxo environment (n8n 2.8.3)
