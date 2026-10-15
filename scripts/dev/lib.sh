# Shared helpers for the dev-loop scripts. Source, don't execute.
set -euo pipefail
DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$DEV_DIR/../.." && pwd)"
[ -f "$DEV_DIR/dev.env" ] || { echo "missing $DEV_DIR/dev.env (copy dev.env.example)" >&2; exit 1; }
set -a; . "$DEV_DIR/dev.env"; set +a
DEV_PREFIX="${DEV_PREFIX:-DEV}"

# target_var <target> <NAME> → value of ${TARGET}_${NAME}
target_var() { local v="$(echo "$1" | tr a-z A-Z)_$2"; printf '%s' "${!v:-}"; }

check_target() {
	case "${1:-}" in test|prod) ;; *) echo "target must be 'test' or 'prod'" >&2; exit 2 ;; esac
	[ -n "$(target_var "$1" URL)" ] || { echo "$(echo "$1" | tr a-z A-Z)_URL not set" >&2; exit 1; }
}

# api <target> <METHOD> <path> [json-body-file]
api() {
	local url key; url="$(target_var "$1" URL)"; key="$(target_var "$1" API_KEY)"
	curl -sS --fail-with-body -X "$2" -H "X-N8N-API-KEY: $key" -H 'Content-Type: application/json' \
		"$url/api/v1$3" ${4:+--data-binary @"$4"}
}

wait_healthy() {
	local url; url="$(target_var "$1" URL)"
	local key; key="$(target_var "$1" API_KEY)"
	# /healthz answers before the REST/public API routes are mounted — wait for the API
	for _ in $(seq 1 90); do
		curl -sf -H "X-N8N-API-KEY: $key" "$url/api/v1/workflows?limit=1" >/dev/null && return 0
		sleep 2
	done
	echo "n8n at $url did not come back healthy" >&2; return 1
}

# running_executions <target> → number of executions currently running
running_executions() {
	api "$1" GET "/executions?status=running&limit=250" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("data",[])))'
}
