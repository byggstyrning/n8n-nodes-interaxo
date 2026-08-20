# Changelog

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
