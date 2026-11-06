#!/usr/bin/env bash
# Deploys the busy page Worker (apps/busy-worker) onto global.beanpool.org/*, or takes it away. README.md, "Deploy".
#
#   bash scripts/busy-page-deploy.sh --dry-run   bundle it and show what would upload; needs no token, contacts nothing
#   bash scripts/busy-page-deploy.sh             deploy, both switches off: the busy page only when the origin fails or is slow
#   bash scripts/busy-page-deploy.sh --force     deploy with BUSY_FORCE=1: every page request gets the busy page
#   bash scripts/busy-page-deploy.sh --off       deploy with BUSY_OFF=1: everything passes straight through
#   bash scripts/busy-page-deploy.sh --remove    delete the Worker, and with it its route: global is as it was before
#
# The token comes from the environment as CLOUDFLARE_WORKERS_TOKEN and goes to wrangler alone, as CLOUDFLARE_API_TOKEN.
# It is never printed. Its scopes (README "The token"): Account · Workers Scripts · Edit, Account · Account Settings ·
# Read, and Zone · Workers Routes · Edit + Zone · Zone · Read for beanpool.org only.
set -euo pipefail
set +x

cd "$(dirname "$0")/.."

mode="${1:-deploy}"
case "$mode" in
    --dry-run | deploy | --force | --off | --remove) ;;
    -h | --help)
        sed -n '2,13p' "$0"
        exit 0
        ;;
    *)
        echo "unknown option: $mode (try --help)" >&2
        exit 2
        ;;
esac

# Wrangler's usage reports go to Cloudflare; this script sends none.
export WRANGLER_SEND_METRICS=false

# The workspace's own wrangler (the repo hoists packages to its root node_modules, .npmrc node-linker=hoisted), never a
# download: --no-install fails instead of fetching one.
wrangler() {
    npx --no-install wrangler "$@"
}

if [ "$mode" = "--dry-run" ]; then
    out="$(mktemp -d)"
    # No token in a dry run, so nothing can reach Cloudflare even by mistake.
    unset CLOUDFLARE_API_TOKEN CLOUDFLARE_WORKERS_TOKEN
    wrangler deploy --dry-run --outdir "$out"
    echo "dry run: bundle in $out (nothing was uploaded)"
    exit 0
fi

if [ -z "${CLOUDFLARE_WORKERS_TOKEN:-}" ]; then
    echo "CLOUDFLARE_WORKERS_TOKEN is not set (README \"The token\" has its scopes)" >&2
    exit 1
fi
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_WORKERS_TOKEN}"
unset CLOUDFLARE_WORKERS_TOKEN
# The BeanPool account (public: apps/registrar's deploy names it too). Saves wrangler a lookup the token cannot do.
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-151a28c4fd1e6ee09768f4226be76b4d}"

case "$mode" in
    deploy) wrangler deploy --var BUSY_FORCE:0 --var BUSY_OFF:0 ;;
    --force) wrangler deploy --var BUSY_FORCE:1 --var BUSY_OFF:0 ;;
    --off) wrangler deploy --var BUSY_FORCE:0 --var BUSY_OFF:1 ;;
    --remove) wrangler delete --name beanpool-busy-page ;;
esac
