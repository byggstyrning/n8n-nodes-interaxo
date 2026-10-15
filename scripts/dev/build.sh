#!/usr/bin/env bash
# Build + lint the package in Docker (no local Node.js needed). Same Node/npm as CI.
. "$(dirname "$0")/lib.sh"
D=(docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_update_notifier=false
	-v "$PKG_DIR:/home/node/pkg" -w /home/node/pkg node:lts-alpine)
if [ ! -x "$PKG_DIR/node_modules/.bin/n8n-node" ]; then
	"${D[@]}" npm ci --no-audit --no-fund
fi
# never let npx fall back to the registry: the bare name "n8n-node" is a squatted placeholder
"${D[@]}" sh -c 'node_modules/.bin/n8n-node build && node_modules/.bin/eslint .'
echo "build + lint OK"
