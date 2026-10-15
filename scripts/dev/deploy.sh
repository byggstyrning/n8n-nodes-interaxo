#!/usr/bin/env bash
# Load the current dist/ into an n8n instance.
#   deploy.sh test          restart the test instance (it mounts ./dist already)
#   deploy.sh prod          copy dist/ to <PROD_DATA_DIR>/custom/n8n-nodes-interaxo and
#                           restart prod n8n once no execution is running (waits up to
#                           --wait minutes, default 30). The published community package
#                           stays installed and untouched; the dev build loads beside it
#                           as node type CUSTOM.interaxo.
#   --dry-run               show what would happen
. "$(dirname "$0")/lib.sh"
TARGET="${1:-}"; shift || true; check_target "$TARGET"
DRY=0; WAIT_MIN=30
while [ $# -gt 0 ]; do case "$1" in --dry-run) DRY=1 ;; --wait) WAIT_MIN="$2"; shift ;; esac; shift; done
CONTAINER="$(target_var "$TARGET" CONTAINER)"; DATA_DIR="$(target_var "$TARGET" DATA_DIR)"
[ -f "$PKG_DIR/dist/nodes/Interaxo/Interaxo.node.js" ] || { echo "no dist/ — run build.sh first" >&2; exit 1; }

if [ -n "$DATA_DIR" ]; then
	DEST="$DATA_DIR/custom/n8n-nodes-interaxo"
	echo "sync dist/ → $DEST"
	if [ "$DRY" = 0 ]; then mkdir -p "$DEST"; rsync -a --delete "$PKG_DIR/dist/" "$DEST/"; fi
fi

if [ "$TARGET" = prod ]; then
	deadline=$(( $(date +%s) + WAIT_MIN * 60 ))
	while :; do
		n="$(running_executions prod)"
		[ "$n" = 0 ] && break
		[ "$(date +%s)" -ge "$deadline" ] && { echo "still $n running execution(s) after ${WAIT_MIN} min — not restarting" >&2; exit 3; }
		echo "$n execution(s) running — waiting"; sleep 30
	done
fi

echo "restart $CONTAINER"
[ "$DRY" = 1 ] && exit 0
# n8n finishes in-flight executions on SIGTERM (graceful shutdown); docker's default
# 10 s before SIGKILL is too short for that, so allow 90 s
docker restart -t 90 "$CONTAINER" >/dev/null
wait_healthy "$TARGET"
if docker logs --since 3m "$CONTAINER" 2>&1 | grep -i -E "custom.*(error|fail)|interaxo.*(error|fail)"; then
	echo "node load errors above" >&2; exit 4
fi
echo "deployed to $TARGET"
