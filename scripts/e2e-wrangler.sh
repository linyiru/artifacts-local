#!/usr/bin/env bash
# End-to-end check under real `wrangler dev`: example app -> shim Worker (RPC) -> artifacts-local,
# plus `git push` to the remote the app hands back. Exits non-zero on the first mismatch.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
EMU_PORT=${EMU_PORT:-8788}
DEV_PORT=${DEV_PORT:-8791}
WRANGLER=${WRANGLER:-wrangler@4.137.0}
WORK=$(mktemp -d)
# wrangler runs under npx and spawns workerd; kill the whole tree, children first.
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  [ -n "${DEV_PID:-}" ] && kill_tree "$DEV_PID"
  [ -n "${EMU_PID:-}" ] && kill_tree "$EMU_PID"
  rm -rf "$WORK"
}
trap cleanup EXIT

for p in "$EMU_PORT" "$DEV_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is in use" >&2; exit 1; fi
done

node "$ROOT/src/cli.ts" serve --port "$EMU_PORT" --data-dir "$WORK/data" \
  --subscribe artifacts-events:artifacts --subscribe artifacts-events:artifacts.repo:default/e2e >"$WORK/emu.log" 2>&1 &
EMU_PID=$!
env -u CLOUDFLARE_API_TOKEN npx -y "$WRANGLER" dev -e local \
  -c "$ROOT/examples/hello/wrangler.jsonc" -c "$ROOT/worker/wrangler.jsonc" \
  --port "$DEV_PORT" --ip 127.0.0.1 --inspector-port 0 >"$WORK/dev.log" 2>&1 &
DEV_PID=$!
for _ in $(seq 1 120); do grep -q 'Ready on' "$WORK/dev.log" 2>/dev/null && break; sleep 1; done
grep -q 'Ready on' "$WORK/dev.log" || { cat "$WORK/dev.log"; exit 1; }

APP=http://127.0.0.1:$DEV_PORT
expect() { if [ "$2" != "$3" ]; then echo "FAIL $1: expected [$3] got [$2]" >&2; exit 1; fi; echo "ok   $1"; }

R=$(curl -sf "$APP/create?repo=e2e")
TOKEN=$(jq -r .token <<<"$R"); REMOTE=$(jq -r .remote <<<"$R")
expect "create returns remote" "$REMOTE" "http://127.0.0.1:$EMU_PORT/git/default/e2e.git"

export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@example.com GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@example.com
git init -q -b main "$WORK/w"
printf '# Hello from git\n' >"$WORK/w/README.md"
git -C "$WORK/w" add -A && git -C "$WORK/w" commit -qm "add readme"
git -C "$WORK/w" -c http.extraHeader="Authorization: Bearer $TOKEN" push -q "$REMOTE" main
echo "ok   git push"

expect "readme body" "$(curl -sf "$APP/readme?repo=e2e")" "# Hello from git"
expect "readme type" "$(curl -sf -o /dev/null -w '%{content_type}' "$APP/readme?repo=e2e")" "text/plain;charset=utf-8"
expect "log" "$(curl -sf "$APP/log?repo=e2e" | jq -c '[.[].message]')" '["add readme"]'
expect "fork" "$(curl -sf "$APP/fork?repo=e2e&to=e2e-fork" | jq -r .name)" "e2e-fork"
expect "list" "$(curl -sf "$APP/list" | jq -c '[.repos[]|[.name,.status]]')" '[["e2e-fork","ready"],["e2e","ready"]]'
expect "missing repo code" "$(curl -s "$APP/readme?repo=nope" | jq -r .error.code)" "NOT_FOUND"
expect "pushed event" "$(curl -sf "http://127.0.0.1:$EMU_PORT/__local/events?type=cf.artifacts.repo.pushed" | jq -r '.[0].payload.ref')" "refs/heads/main"

# Events reach the app's queue() consumer through the local Queue the shim feeds.
for _ in $(seq 1 50); do
  curl -sf "$APP/events" | jq -e 'map(.type) | index("cf.artifacts.repo.pushed")' >/dev/null && break
  sleep 0.2
done
expect "queue consumer got pushed" "$(curl -sf "$APP/events" | jq -r '[.[] | select(.type == "cf.artifacts.repo.pushed")][0].payload.ref')" "refs/heads/main"
expect "queue consumer got created" "$(curl -sf "$APP/events" | jq -r '[.[].type] | index("cf.artifacts.repo.created") != null')" "true"
echo "e2e: all checks passed"
