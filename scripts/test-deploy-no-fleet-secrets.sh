#!/bin/bash
# Does deploy.sh keep the fleet's secrets off our servers?
#
# WHY THIS EXISTS. Until 2026-09-28 deploy.sh handed every server four values from the Mac's .env: CF_API_TOKEN and CF_ZONE_ID
# (a token that can rewrite DNS for the whole beanpool.org zone), the one ADMIN_PASSWORD all our servers shared, and
# CF_TUNNEL_TOKEN, written to data/tunnel-token with mode 0644 and run by a cloudflared sidecar on test and yarravalley. A
# break-in at any one server could have repointed global.beanpool.org (sensitive-data report A8). This fails the build if
# any of that comes back.
#
# Three parts. The first reads deploy.sh itself. The second RUNS deploy.sh with ssh, scp and curl stubbed and a .invalid host,
# so no server is contacted, and reads what it would have sent: the scripts piped to ssh, ssh's arguments and the package scp
# uploads. The third runs the cleanup helpers deploy.sh ships (scripts/deploy-lib.sh) against temp files.
#
#   bash scripts/test-deploy-no-fleet-secrets.sh
#   DEPLOY_SH=/path/to/an/older/deploy.sh bash scripts/test-deploy-no-fleet-secrets.sh   # must fail on origin/main before this
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_SH="${DEPLOY_SH:-$ROOT/deploy.sh}"
SB="$(mktemp -d)"; trap 'rm -rf "$SB"' EXIT
run=0; passed=0
assert() { run=$((run+1)); if [ "$2" = "$3" ]; then passed=$((passed+1)); echo "✓ $1"; else echo "✗ $1 (expected '$3', got '$2')"; fi; }
# shellcheck source=deploy-lib.sh
. "$ROOT/scripts/deploy-lib.sh"

NAMES_RE="$(fleet_secret_names | tr ' ' '|')"
assert "the four names are the ones the report named" "$(fleet_secret_names)" "CF_API_TOKEN CF_ZONE_ID ADMIN_PASSWORD CF_TUNNEL_TOKEN"

# Lines that write or loosen data/tunnel-token: tee, cp, mv, install or chmod naming it, or a redirect into it.
TOKEN_WRITE_RE='(^|[^[:alnum:]_])(tee|cp|mv|install|chmod)[[:space:]].*tunnel-token|>[[:space:]]*[^[:space:]]*tunnel-token'
# A line that starts the cloudflared sidecar: the tunnel profile anywhere but on a down, or COMPOSE_PROFILES.
sidecar_starts() { grep -E -- '--profile[[:space:]]+tunnel|COMPOSE_PROFILES' | grep -vE '[[:space:]]down([[:space:]]|$)'; }
code_lines() { grep -vE '^[[:space:]]*#'; }

echo "--- deploy.sh as written: $DEPLOY_SH ---"
# Every heredoc deploy.sh pipes to ssh. The LOCAL shell expands them, so a name in one, comments included, sends its value.
HEREDOCS="$SB/heredocs.sh"
awk '/<< EOF/ {inside=1; next} /^EOF$/ {inside=0} inside' "$DEPLOY_SH" > "$HEREDOCS"
assert "found the remote blocks deploy.sh sends over ssh" "$([ -s "$HEREDOCS" ] && echo yes || echo no)" "yes"
hits=$(grep -nE "$NAMES_RE" "$HEREDOCS")
assert "no remote block names $NAMES_RE" "${hits:-none}" "none"
hits=$(grep -nE '(^|[^[:alnum:]_])(ssh|scp)[[:space:]]' "$DEPLOY_SH" | grep -E "$NAMES_RE")
assert "no ssh or scp command line names one of them" "${hits:-none}" "none"
hits=$(code_lines < "$DEPLOY_SH" | grep -E "$TOKEN_WRITE_RE")
assert "deploy.sh never writes or chmods data/tunnel-token" "${hits:-none}" "none"
hits=$(code_lines < "$DEPLOY_SH" | sidecar_starts)
assert "deploy.sh never starts the cloudflared sidecar (the tunnel profile only on a down)" "${hits:-none}" "none"
n=$(code_lines < "$DEPLOY_SH" | grep -cE -- '--profile[[:space:]]+tunnel .*[[:space:]]down([[:space:]]|$)')
assert "a down with the tunnel profile still stops a sidecar an earlier deploy started" "$([ "$n" -ge 1 ] && echo yes || echo no)" "yes"

echo ""
echo "--- a dry run of deploy.sh against a stubbed server ---"
APP="$SB/app"; BIN="$SB/bin"; CAP="$SB/captured"
mkdir -p "$APP/scripts" "$BIN" "$CAP"
cp "$DEPLOY_SH" "$APP/deploy.sh"
cp "$ROOT/scripts/deploy-lib.sh" "$APP/scripts/deploy-lib.sh"
# Values that appear nowhere else, so finding one anywhere means it was sent.
# printf, not a heredoc: test-all's secrets_guard refuses any tracked line that starts NAME= for these names.
printf '%s=%s\n' \
  CF_API_TOKEN 'sentinel-cf-api-token-3f9a61' \
  CF_ZONE_ID 'sentinel-cf-zone-id-77c1d0' \
  ADMIN_PASSWORD 'Sentinel-admin-password-5d2e!' \
  CF_TUNNEL_TOKEN 'sentinel-cf-tunnel-token-b2e4c8' > "$APP/.env"
SENTINELS='sentinel-cf-api-token-3f9a61|sentinel-cf-zone-id-77c1d0|Sentinel-admin-password-5d2e|sentinel-cf-tunnel-token-b2e4c8'
FLEET_SHA=$(printf '%s' 'sentinel-cf-tunnel-token-b2e4c8' | sha256_hex)
# test: a build node (no registry lookup) and one of the two that used to start the sidecar.
echo "1:test:deploy-guard.invalid:test.deploy-guard.invalid:root:BeanPool-Test" > "$APP/deploy-targets.conf"

# ssh: a script on stdin is kept; the health probe's container query answers "running 0". Nothing is contacted.
cat > "$BIN/ssh" << STUB
#!/bin/bash
printf '%s\n' "\$*" >> "$CAP/ssh-args.log"
last="\${!#}"
if [ "\$last" = "/bin/bash" ]; then
  n=\$(ls "$CAP" | grep -c '^remote-')
  cat > "$CAP/remote-\$n.sh"
  exit 0
fi
case "\$*" in *"docker ps -aq"*"docker inspect"*) echo "running 0" ;; esac
exit 0
STUB
cat > "$BIN/scp" << STUB
#!/bin/bash
printf '%s\n' "\$*" >> "$CAP/scp-args.log"
for a in "\$@"; do case "\$a" in *.tar.gz) cp "\$a" "$CAP/package.tar.gz" ;; esac; done
exit 0
STUB
# curl: the health check reads the status code; 401 is a node answering with read auth on.
printf '#!/bin/bash\necho 401\n' > "$BIN/curl"
printf '#!/bin/bash\nexit 1\n' > "$BIN/docker"
# deploy.sh ends by removing a legacy /tmp file; keep this run inside its sandbox.
printf '#!/bin/bash\ncase "$*" in */tmp/beanpool-deploy.tar.gz*) exit 0 ;; esac\nexec /bin/rm "$@"\n' > "$BIN/rm"
chmod +x "$BIN"/*

: > "$APP/.deploy-package.tar.gz"   # GNU tar: "file changed as we read it" when gzip creates it mid-read
PATH="$BIN:$PATH" HEALTH_INTERVAL=0 HEALTH_STREAK=1 HEALTH_TIMEOUT=5 bash "$APP/deploy.sh" 1 > "$SB/deploy-output.log" 2>&1
rc=$?
assert "the stubbed deploy ran to the end" "$rc" "0"
MAIN="$CAP/remote-0.sh"
assert "the node's remote script was captured" "$([ -s "$MAIN" ] && echo yes || echo no)" "yes"
assert "the host cleanup script was captured" "$([ -s "$CAP/remote-1.sh" ] && echo yes || echo no)" "yes"
assert "the remote script is valid bash" "$(bash -n "$MAIN" 2>&1 && echo ok)" "ok"

mkdir -p "$SB/package" && tar -xzf "$CAP/package.tar.gz" -C "$SB/package" 2>/dev/null
hits=$(grep -rlE "$SENTINELS" "$CAP"/remote-*.sh "$CAP/ssh-args.log" "$CAP/scp-args.log" "$SB/package" 2>/dev/null | sed "s|$SB/||")
assert "no fleet secret's value reaches the server (ssh scripts, ssh and scp arguments, the package)" "${hits:-none}" "none"
hits=$(grep -cE "$SENTINELS" "$SB/deploy-output.log")
assert "deploy.sh prints no fleet secret's value" "$hits" "0"
hits=$(grep -nE "export[[:space:]]+($NAMES_RE)([=[:space:]]|$)" "$MAIN")
assert "the remote script exports none of the four" "${hits:-none}" "none"
hits=$(code_lines < "$MAIN" | grep -E "$TOKEN_WRITE_RE")
assert "the remote script never writes or chmods data/tunnel-token" "${hits:-none}" "none"
hits=$(code_lines < "$MAIN" | sidecar_starts)
assert "the remote script never starts the sidecar" "${hits:-none}" "none"
n=$(grep -cE -- "--profile tunnel -p beanpool-test down --remove-orphans" "$MAIN")
assert "the remote down names the project, so it runs and stops an old sidecar" "$n" "1"
assert "the remote script removes the four from the server's .env" \
       "$(grep -cE '^[[:space:]]*strip_fleet_secrets_env "/root/BeanPool-Test/.env"$' "$MAIN")" "1"
assert "the remote script is sent the fleet tunnel token's sha256, to remove only that copy" \
       "$(grep -cE "^[[:space:]]*remove_fleet_tunnel_token \"/root/BeanPool-Test/data/tunnel-token\" \"$FLEET_SHA\"$" "$MAIN")" "1"
assert "the remote script says where a first start's password is" \
       "$(grep -cE '^[[:space:]]*first_password_notice "/root/BeanPool-Test/data" "root@deploy-guard.invalid"$' "$MAIN")" "1"
if [ "$passed" != "$run" ]; then
  echo "   deploy.sh output (last 15 lines):"; tail -15 "$SB/deploy-output.log" | sed 's/^/   | /'
fi

echo ""
echo "--- the cleanup helpers, against temp files ---"
sudo() { "$@"; }
perm() { ls -l "$1" | cut -c1-10; }

ENVF="$SB/node.env"
printf '%s\n' \
  '# a comment that mentions ADMIN_PASSWORD=stays' \
  'NODE_PROFILE=global' \
  'CF_API_TOKEN=val-a' \
  'export CF_ZONE_ID=val-b' \
  '  ADMIN_PASSWORD = "val-c"' \
  'CF_TUNNEL_TOKEN: val-d' \
  'ADMIN_PASSWORD' \
  'CF_API_TOKEN_OLD=keeps-a-longer-name' \
  'MY_CF_ZONE_ID=keeps-a-prefixed-name' \
  'IMAGE_S3_SECRET_ACCESS_KEY=keeps-s3' \
  'INSTAGRAM_APP_SECRET=keeps-pulse' \
  'CF_RECORD_NAME=keeps-the-record-name' > "$ENVF"
printf 'CF_ZONE_ID=val-e\r\n' >> "$ENVF"
chmod 600 "$ENVF"
out=$(strip_fleet_secrets_env "$ENVF"); rc=$?
assert "strip succeeds" "$rc" "0"
assert "only the four names are removed; every other line stays, in order" "$(cat "$ENVF")" "$(printf '%s\n' \
  '# a comment that mentions ADMIN_PASSWORD=stays' \
  'NODE_PROFILE=global' \
  'CF_API_TOKEN_OLD=keeps-a-longer-name' \
  'MY_CF_ZONE_ID=keeps-a-prefixed-name' \
  'IMAGE_S3_SECRET_ACCESS_KEY=keeps-s3' \
  'INSTAGRAM_APP_SECRET=keeps-pulse' \
  'CF_RECORD_NAME=keeps-the-record-name')"
assert "the .env keeps its mode" "$(perm "$ENVF")" "-rw-------"
assert "it says which names it removed" "$(echo "$out" | grep -c 'Removed ADMIN_PASSWORD CF_API_TOKEN CF_TUNNEL_TOKEN CF_ZONE_ID from')" "1"
assert "it prints no value" "$(echo "$out" | grep -cE 'val-[a-e]')" "0"
assert "no temp file is left beside it" "$(ls "$SB" | grep -c 'fleet-strip')" "0"
before=$(cat "$ENVF")
out=$(strip_fleet_secrets_env "$ENVF")
assert "a second run changes nothing and says nothing" "$out|$(cat "$ENVF")" "|$before"
assert "a server with no .env is fine" "$(strip_fleet_secrets_env "$SB/missing.env"; echo "rc=$?")" "rc=0"
printf 'ADMIN_PASSWORD=only-line\n' > "$ENVF"
strip_fleet_secrets_env "$ENVF" > /dev/null
assert "a .env that held only a fleet secret is left empty, not failed" "$(wc -c < "$ENVF" | tr -d ' ')" "0"
# A byte that isn't valid UTF-8, stripped under a UTF-8 locale (Ubuntu's default, and ssh passes the Mac's LANG/LC_*).
printf 'NODE_PROFILE=global\nCF_API_TOKEN=val-a\nCOMMUNITY_NOTE=Caf\351 owner\nADMIN_PASSWORD=p\344ss-val\nIMAGE_S3_BUCKET=keep\n' > "$ENVF"
out=$(LANG=C.UTF-8 LC_ALL=C.UTF-8 strip_fleet_secrets_env "$ENVF" 2>&1)
assert "an invalid UTF-8 byte: only the fleet names go, the other lines stay" "$(cat "$ENVF")" "$(printf 'NODE_PROFILE=global\nCOMMUNITY_NOTE=Caf\351 owner\nIMAGE_S3_BUCKET=keep')"
assert "an invalid UTF-8 byte: both names reported, no value printed" "$(echo "$out" | grep -c 'Removed ADMIN_PASSWORD CF_API_TOKEN from')|$(echo "$out" | grep -acE 'val-a|ss-val')" "1|0"

TOK="$SB/tunnel-token"
echo "sentinel-cf-tunnel-token-b2e4c8" > "$TOK"   # as earlier deploys wrote it: echo, with a newline
out=$(remove_fleet_tunnel_token "$TOK" "$FLEET_SHA")
assert "the fleet's copy of the tunnel token is removed" "$([ -e "$TOK" ] && echo kept || echo removed)" "removed"
assert "and it says so without the token" "$(echo "$out" | grep -c 'Removed')|$(echo "$out" | grep -c 'sentinel')" "1|0"
printf '%s' "this-servers-own-registrar-token" > "$TOK"   # as public-address-agent.ts writes it: trimmed
out=$(remove_fleet_tunnel_token "$TOK" "$FLEET_SHA")
assert "a server's own tunnel token is kept" "$([ -e "$TOK" ] && echo kept || echo removed)" "kept"
assert "and it says it kept it" "$(echo "$out" | grep -c "own tunnel token")" "1"
echo "sentinel-cf-tunnel-token-b2e4c8" > "$TOK"
remove_fleet_tunnel_token "$TOK" "" > /dev/null
assert "with no fleet token on the Mac to compare, nothing is removed" "$([ -e "$TOK" ] && echo kept || echo removed)" "kept"
rm -f "$TOK"
assert "a server with no token file is fine" "$(remove_fleet_tunnel_token "$TOK" "$FLEET_SHA"; echo "rc=$?")" "rc=0"

DATA="$SB/data"; mkdir -p "$DATA"
out=$(first_password_notice "$DATA" "root@node.invalid")
assert "a first start says where the made-up password is" "$(echo "$out" | grep -c "$DATA/first-admin-password.txt")" "2"
assert "and how to read it" "$(echo "$out" | grep -c "ssh root@node.invalid 'sudo cat $DATA/first-admin-password.txt'")" "1"
printf '{\n  "isLocked": false\n}\n' > "$DATA/local-config.json"
assert "an unlocked config also makes one up, and says so" "$(first_password_notice "$DATA" x | grep -c 'first-admin-password.txt')" "2"
printf '{\n  "isLocked": true,\n  "adminHash": "h"\n}\n' > "$DATA/local-config.json"
assert "a locked server says nothing" "$(first_password_notice "$DATA" x)" ""
LC="$ROOT/apps/server/src/config/local-config.ts"
assert "the file name is the server's own (FIRST_PASSWORD_FILE)" \
       "$(grep -c "FIRST_PASSWORD_FILE = 'first-admin-password.txt'" "$LC")" "1"
assert "the config file is the server's own (CONFIG_PATH)" \
       "$(grep -c "CONFIG_PATH = path.join(DATA_DIR, 'local-config.json')" "$LC")" "1"

echo ""
echo "$passed/$run passed"
[ "$passed" = "$run" ] || exit 1
