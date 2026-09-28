#!/bin/bash
set -e

# BeanPool Global Mesh Deploy Script
# Deploys to remote nodes via SSH (local build by default, or pre-built GHCR image)
#
# Usage:
#   bash deploy.sh                              # Deploy to all nodes (local build)
#   bash deploy.sh 1 3 4                        # Deploy to specific nodes by number
#   DEPLOY_PULL=1 bash deploy.sh                # Pull pre-built image (defaults to :latest)
#   DEPLOY_PULL=1 DEPLOY_TAG=<sha> bash deploy.sh  # Pull and deploy specific commit tag
#
# Image tags in GHCR:
#   :latest only moves on a RELEASE (.github/workflows/docker-publish.yml).
#   Pushes to main are tagged with their short-sha (e.g. DEPLOY_TAG=3fb6e72).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# disk_preflight / docker_free_kb (shipped to each host) and wait_node_healthy (run here).
source "$SCRIPT_DIR/scripts/deploy-lib.sh"

# Free space a node needs on its host's docker filesystem before we touch it: the new image plus 2 GB of
# headroom for the node's own data, WAL and logs. The image is 1.21 GB, so a pull needs 3.5 GB. A source
# build also holds the builder stage's cache until the post-deploy builder prune — measured at 2.2 GB on
# qld 2026-09-19 — so it needs 1.21 + 2.2 + 2 = 5.4 GB; 6 GB leaves room for the base-image pull.
PULL_NEED_MB=3584
BUILD_NEED_MB=6144
# After the pull, before the old container stops: the image is already on disk, so only the headroom.
RUN_HEADROOM_MB=2048
# A cheap route that answers without touching the ledger. 401 counts as answering (read auth is on).
HEALTH_PATH="${HEALTH_PATH:-/api/version}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

if [ -n "${DEPLOY_TAG:-}" ] && ! [[ "$DEPLOY_TAG" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  echo "🛑 FATAL: Invalid DEPLOY_TAG: '$DEPLOY_TAG'"
  exit 1
fi

IMAGE="ghcr.io/beanpool-org/beanpool-node:${DEPLOY_TAG:-latest}"

# Load this Mac's .env, if there is one. None of its secrets go to a server any more (FLEET SECRETS in scripts/deploy-lib.sh).
# Its CF_TUNNEL_TOKEN is used only to recognise the copy earlier deploys wrote to each server's data/tunnel-token: a server is
# sent that token's sha256, never the token.
if [ -f "$SCRIPT_DIR/.env" ]; then
  echo "🔑 Loading .env file..."
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi
FLEET_TUNNEL_SHA=""
if [ -n "${CF_TUNNEL_TOKEN:-}" ]; then
  FLEET_TUNNEL_SHA=$(printf '%s' "$CF_TUNNEL_TOKEN" | tr -d '[:space:]' | sha256_hex)
fi

# Load targets from local configuration file if it exists, otherwise fall back to example target
if [ -f "$SCRIPT_DIR/deploy-targets.conf" ]; then
  NODES=()
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line//[[:space:]]/}" ]] && continue
    NODES+=("$line")
  done < "$SCRIPT_DIR/deploy-targets.conf"
else
  NODES=(
    "1:example-node:example.org:example.org:user:Folder"
  )
fi

# Determine which nodes to deploy
TARGETS=()
if [ $# -gt 0 ]; then
  for NUM in "$@"; do
    for NODE in "${NODES[@]}"; do
      if [[ "$NODE" == "$NUM:"* ]]; then
        TARGETS+=("$NODE")
      fi
    done
  done
else
  TARGETS=("${NODES[@]}")
fi

echo ""
if [ $# -eq 0 ]; then
  echo "⚠️  No node numbers given — this deploys EVERY node in deploy-targets.conf."
fi
echo "🌍 Deploying to ${#TARGETS[@]} node(s):"
if [ -n "${DEPLOY_TAG:-}" ]; then
  echo "🏷️  Deploy tag: $DEPLOY_TAG"
fi
if [ "${DEPLOY_PULL:-}" = "1" ] && [ -z "${DEPLOY_TAG:-}" ]; then
  echo "⚠️  WARNING: :latest is the last RELEASE, not main — pass DEPLOY_TAG=<sha> to deploy a commit from main"
fi
for NODE in "${TARGETS[@]}"; do
  NAME=$(echo "$NODE" | cut -d: -f2)
  IP=$(echo "$NODE" | cut -d: -f3)
  DNS=$(echo "$NODE" | cut -d: -f4)
  echo "   $NAME ($IP) → $DNS"
done
echo ""

# Verify image in registry before touching any node if pulling is requested or required
NEEDS_REGISTRY_IMAGE=0
if [ "${DEPLOY_PULL:-}" = "1" ]; then
  NEEDS_REGISTRY_IMAGE=1
else
  for NODE in "${TARGETS[@]}"; do
    NODE_NAME=$(echo "$NODE" | cut -d: -f2)
    case "$NODE_NAME" in
      test|review|mullum1|melb|castlemaine|bris|mullum|gippsland|eastgippy|bindarrabi|yarravalley) ;;
      *) NEEDS_REGISTRY_IMAGE=1 ;;
    esac
  done
fi

if [ "$NEEDS_REGISTRY_IMAGE" = "1" ]; then
  echo "🔍 Verifying $IMAGE exists in registry before touching any node..."
  IMAGE_FOUND=0
  if docker manifest inspect "$IMAGE" >/dev/null 2>&1; then
    IMAGE_FOUND=1
  else
    REGISTRY_TOKEN=$(curl -fsSL "https://ghcr.io/token?scope=repository:beanpool-org/beanpool-node:pull" 2>/dev/null | sed -n -E 's/.*"token":"([^"]+)".*/\1/p')
    if [ -n "$REGISTRY_TOKEN" ]; then
      HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $REGISTRY_TOKEN" \
        -H "Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json" \
        "https://ghcr.io/v2/beanpool-org/beanpool-node/manifests/${DEPLOY_TAG:-latest}")
      if [ "$HTTP_STATUS" = "200" ]; then
        IMAGE_FOUND=1
      fi
    fi
  fi

  if [ "$IMAGE_FOUND" -ne 1 ]; then
    echo ""
    echo "🛑 FATAL: Image $IMAGE does not exist in registry!"
    echo "   The build for tag '${DEPLOY_TAG:-latest}' failed or has not completed yet."
    echo "   Aborting deploy to prevent rolling back nodes to a stale local image."
    echo "   Check build status: https://github.com/beanpool-org/beanpool/actions"
    echo ""
    exit 1
  fi
  echo "✅ Verified image exists in registry: $IMAGE"
  echo ""
fi

# Package docker-compose.yml + data-preserving deploy config
PKG_PATH="$SCRIPT_DIR/.deploy-package.tar.gz"
echo "📦 Packaging deploy config..."
tar -czf "$PKG_PATH" \
    --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='.turbo' \
    --exclude='.next' --exclude='out' --exclude='archive' --exclude='apps/native' --exclude='apps/native.bak' \
    --exclude='*.apk' --exclude='data' --exclude='.env' --exclude='.env.*' --exclude='builds' \
    --exclude='.deploy-package.tar.gz' \
    --exclude='ios' --exclude='.expo' --exclude='scratch' \
    -C "$SCRIPT_DIR" .
echo "✅ Package ready: $(du -h "$PKG_PATH" | cut -f1)"

# A pull-mode node takes the GHCR image; a build-mode node builds from the tarball on its host.
is_build_node() {
  case "$1" in
    test|review|mullum1|melb|castlemaine|bris|mullum|gippsland|eastgippy|bindarrabi|yarravalley) return 0 ;;
    *) return 1 ;;
  esac
}

# "<status> <restart count>" of the current node's container, over ssh. Reads the loop's globals.
remote_node_state() {
  local out
  out=$(ssh $SSH_OPTS $USER@$IP "C=\$(sudo docker ps -aq --filter label=com.docker.compose.project=$PROJ_NAME --filter label=com.docker.compose.service=beanpool-node | head -n1); [ -n \"\$C\" ] && sudo docker inspect -f '{{.State.Status}} {{.RestartCount}}' \"\$C\" 2>/dev/null || echo 'missing -'" 2>/dev/null) || true
  echo "${out:-unreachable -}"
}

FAILED_NODES=()
FAILED_HOSTS=()
BUSY_HOSTS=()
OK_NODES=()

# Deploy each node. A failure on one node is recorded and the loop moves on; the exit code and the summary
# at the end report it.
for NODE in "${TARGETS[@]}"; do
  NAME=$(echo "$NODE" | cut -d: -f2)
  IP=$(echo "$NODE" | cut -d: -f3)
  DNS=$(echo "$NODE" | cut -d: -f4)
  USER=$(echo "$NODE" | cut -d: -f5)
  DIR=$(echo "$NODE" | cut -d: -f6)
  if [ -z "$DIR" ]; then DIR="BeanPool"; fi
  if [ "$USER" = "root" ]; then
    HOME_DIR="/root"
  else
    HOME_DIR="/home/$USER"
  fi
  PROJECT_DIR="$HOME_DIR/$DIR"
  PROJ_NAME=$(echo "$DIR" | tr '[:upper:]' '[:lower:]')

  # Azure nodes use the lattice SSH key; others use default
  # accept-new, never "no": ssh-qld / ssh-vic / ssh-global are names in DNS that point at a tunnel. If one were re-pointed at
  # another server (a registrar claim, a DNS mistake), "no" would hand that server our deploy and everything it sends; accept-new
  # refuses a host whose key changed and still accepts a host's key the first time. A real key change: check the new fingerprint
  # out of band, then ssh-keygen -R <host>.
  if [ "$USER" = "azureuser" ]; then
    SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes -i ~/.ssh/id_azure_lattice"
  else
    SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes"
  fi

  echo "====================================="
  echo "🚀 Deploying $NAME ($IP) → $DNS"
  if [ -n "${DEPLOY_TAG:-}" ]; then
    echo "🏷️  Tag: $DEPLOY_TAG"
  else
    echo "🏷️  Tag: latest"
  fi
  echo "====================================="

  if [ "${DEPLOY_PULL:-}" = "1" ] || ! is_build_node "$NAME"; then
    PULL_FIRST=1; NEED_MB=$PULL_NEED_MB
  else
    PULL_FIRST=0; NEED_MB=$BUILD_NEED_MB
  fi

  # Upload, under a name that is this run's own: a second deploy uploading at the same moment then cannot swap the code
  # under this one. The remote step removes it when it ends.
  REMOTE_PKG="$HOME_DIR/beanpool-deploy-$DIR-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM.tar.gz"
  if ! scp $SSH_OPTS "$PKG_PATH" $USER@$IP:$REMOTE_PKG; then
    echo "❌ $NAME: upload failed — nothing on the node was touched."
    FAILED_NODES+=("$NAME (upload failed)"); FAILED_HOSTS+=("$USER@$IP")
    continue
  fi

  # Lock, check the data, check disk, pull, stop, preserve data, extract, start.
  # Remote exit 3 = aborted BEFORE the running container was touched. 4 = another deploy of this node holds the lock; nothing
  # was touched.
  REMOTE_RC=0
  ssh $SSH_OPTS $USER@$IP "/bin/bash" << EOF || REMOTE_RC=$?
    $(declare -f docker_free_kb disk_preflight fleet_secret_names sha256_hex strip_fleet_secrets_env remove_fleet_tunnel_token first_password_notice check_data_copies describe_data_copy data_copy_file_line containers_using)
    trap 'rm -f "$REMOTE_PKG"' EXIT
    # One deploy at a time for this node on this server. On 2026-09-28 two deploys of test ran at once, the second set aside
    # the data the first had parked, and the node started a new, empty community. The lock is held until this shell ends,
    # however it ends, so a deploy that is cut off never leaves it behind. The lock file is never removed.
    if ! command -v flock >/dev/null 2>&1; then
      echo "🛑 ABORT $NAME: this server has no flock (package util-linux), which deploy.sh needs to keep two deploys apart. Nothing was changed."
      exit 3
    fi
    exec 9>>"$HOME_DIR/beanpool-deploy-$DIR.lock" || {
      echo "🛑 ABORT $NAME: could not open the deploy lock $HOME_DIR/beanpool-deploy-$DIR.lock. Nothing was changed."
      exit 3
    }
    flock -n 9 || {
      echo "🛑 REFUSED $NAME: another deploy of $DIR is running on this server right now. Nothing was changed."
      echo "   Let it finish, then deploy again. (It holds $HOME_DIR/beanpool-deploy-$DIR.lock until it ends.)"
      exit 4
    }
    # A copy of data/ or .env parked by a deploy that did not finish: put back if nothing is in its place, and otherwise
    # stop here, before anything changes.
    check_data_copies "$HOME_DIR" "$DIR" "$PROJECT_DIR" || exit 3
    if [ "$PULL_FIRST" = "1" ]; then PREFLIGHT_LABEL="pull"; else PREFLIGHT_LABEL="source build"; fi
    disk_preflight $NEED_MB "$NAME, \$PREFLIGHT_LABEL" || {
      echo "🛑 ABORT $NAME: not enough free disk even after pruning unused images. The running container is untouched."
      df -h / | sed 's/^/   /'
      exit 3
    }
    if [ "$PULL_FIRST" = "1" ]; then
      # Pull while the old container is still serving: a failed pull or a full disk then costs no downtime,
      # and compose cannot fall back to a surprise source build.
      echo "📥 Pulling $IMAGE (the running $NAME container is untouched until this succeeds)..."
      sudo docker pull "$IMAGE" || {
        echo "🛑 ABORT $NAME: docker pull $IMAGE failed. The running container is untouched."
        exit 3
      }
      disk_preflight $RUN_HEADROOM_MB "$NAME, after pull" no-prune || {
        echo "🛑 ABORT $NAME: the pull left too little free disk to run safely. The running container is untouched."
        exit 3
      }
    fi
    # Stop the node before anything of its moves. This used to run only when cd $PROJECT_DIR worked, so after a deploy cut
    # off between the wipe and the extract, the old container was left running.
    (
      cd $PROJECT_DIR 2>/dev/null || cd $HOME_DIR
      sudo docker rm -f $PROJ_NAME-beanpool-node-1 2>/dev/null || true
      sudo docker rm -f beanpool-$PROJ_NAME-beanpool-node-1 2>/dev/null || true
      sudo docker rm -f beanpool-beanpool-$NAME-beanpool-node-1 2>/dev/null || true
      # The tunnel profile stops the compose cloudflared sidecar that earlier deploys started on test and yarravalley. Until
      # 2026-09-28 the project name here was escaped, so the server read an empty variable, compose failed on its arguments,
      # and these two lines never ran.
      sudo docker compose --profile tunnel -p $PROJ_NAME down --remove-orphans 2>/dev/null || true
      sudo docker compose --profile tunnel -p beanpool-$PROJ_NAME down --remove-orphans 2>/dev/null || true
      sleep 1
    )
    # A bind mount follows its folder when that is moved, so anything still running with data/ mounted would go on writing
    # into the parked copy below (test, 2026-09-28). Stop it, whatever it is called; move nothing while anything still has it.
    RUNNING_ON_DATA=\$(containers_using "$PROJECT_DIR/data")
    if [ -n "\$RUNNING_ON_DATA" ]; then
      echo "⏹  Still running with $PROJECT_DIR/data mounted: \$(echo \$RUNNING_ON_DATA). Stopping it before anything moves."
      for C in \$RUNNING_ON_DATA; do sudo docker stop "\$C" >/dev/null 2>&1; done
      RUNNING_ON_DATA=\$(containers_using "$PROJECT_DIR/data")
    fi
    if [ -n "\$RUNNING_ON_DATA" ]; then
      echo "🛑 FATAL: \$(echo \$RUNNING_ON_DATA) will not stop and still has $PROJECT_DIR/data mounted. Nothing was moved; data/ is where it was."
      echo "   The node is stopped. Do not start it while that still runs: two servers on one database can damage it."
      echo "   Stop that container (sudo docker stop <name>, or sudo systemctl restart docker), then deploy again."
      exit 1
    fi
    # --- BEGIN preserve/restore (scripts/test-deploy-preserve.sh checks this block and runs it, as sent, on a stand-in server) ---
    # Preserve data/ and .env across the wipe below.
    #
    # NOTE: this whole block is inside an UNQUOTED heredoc, so the LOCAL shell expands it before
    # it is ever sent. Never use backticks or an unescaped dollar-paren in here, comments included
    # — bash runs them on YOUR machine. Doing exactly that is what produced
    # "syntax error near unexpected token ||" on every node deployed 2026-08-25.
    # test-deploy-preserve.sh now fails the build if either reappears.
    #
    # mv SRC DEST moves SRC *into* DEST when DEST is an existing directory rather than replacing
    # it. Both moves here used to be bare mv with 2>/dev/null and a || true, so a backup left
    # behind by an interrupted deploy silently turned the NEXT deploy into
    # data/beanpool-data-backup-<DIR>/... — an entire stale data dir nested inside the live one,
    # and the || true meant nothing was ever reported. Worse: the live ledger ended up buried at
    # data/data/state.db while data/ was repopulated from the STALE copy, so the node booted on a
    # different community.key. Found on test 2026-08-25 holding 220 MB (186 MB of it snapshots),
    # which also inflated every snapshot and harvest taken of data/.
    #
    # Two rules from then: the destination is guaranteed not to exist before each move, and failing to
    # preserve or restore data/ is FATAL. Continuing past that would wipe a node's identity keys
    # and ledger, which is not something to shrug off.
    #
    # 2026-09-28 on test: two deploys ran at once. The first parked data/; the second found the parked
    # copy, called it stale because "the live data/ is authoritative", moved it to .stale, found no
    # data/ left to keep, and the node started a new, empty community. So also: one deploy at a time
    # (the lock at the top), a parked copy with nothing in its place IS the node's and is put back, a
    # parked copy with something in its place stopped this deploy before anything changed
    # (check_data_copies), and nothing here deletes a copy of anyone's data.
    if [ -e "$HOME_DIR/beanpool-data-backup-$DIR" ] || [ -L "$HOME_DIR/beanpool-data-backup-$DIR" ]; then
      if [ -e "$PROJECT_DIR/data" ] || [ -L "$PROJECT_DIR/data" ]; then
        echo "🛑 FATAL: both $PROJECT_DIR/data and $HOME_DIR/beanpool-data-backup-$DIR exist. Nothing was moved."; exit 1
      fi
      # check_data_copies said so above: the parked copy is this node's data, and is put back below.
    elif [ -e "$PROJECT_DIR/data" ] || [ -L "$PROJECT_DIR/data" ]; then
      sudo mv "$PROJECT_DIR/data" "$HOME_DIR/beanpool-data-backup-$DIR" || {
        echo "🛑 FATAL: could not preserve $PROJECT_DIR/data — refusing to wipe the project dir."; exit 1; }
    fi
    if [ -e "$HOME_DIR/beanpool-env-backup-$DIR" ] || [ -L "$HOME_DIR/beanpool-env-backup-$DIR" ]; then
      if [ -e "$PROJECT_DIR/.env" ] || [ -L "$PROJECT_DIR/.env" ]; then
        echo "🛑 FATAL: both $PROJECT_DIR/.env and $HOME_DIR/beanpool-env-backup-$DIR exist. Nothing was moved."; exit 1
      fi
    elif [ -e "$PROJECT_DIR/.env" ] || [ -L "$PROJECT_DIR/.env" ]; then
      sudo mv "$PROJECT_DIR/.env" "$HOME_DIR/beanpool-env-backup-$DIR" || {
        echo "🛑 FATAL: could not preserve $PROJECT_DIR/.env — refusing to wipe the project dir."; exit 1; }
    fi
    if [ -e "$PROJECT_DIR/data" ] || [ -L "$PROJECT_DIR/data" ] || [ -e "$PROJECT_DIR/.env" ] || [ -L "$PROJECT_DIR/.env" ]; then
      echo "🛑 FATAL: data/ or .env is still in $PROJECT_DIR after preserving it — refusing to wipe the project dir."; exit 1
    fi
    sudo rm -rf $PROJECT_DIR
    mkdir -p $PROJECT_DIR
    tar -xzf "$REMOTE_PKG" -C $PROJECT_DIR
    if [ -e "$HOME_DIR/beanpool-data-backup-$DIR" ] || [ -L "$HOME_DIR/beanpool-data-backup-$DIR" ]; then
      # The tarball excludes data/. If one came out of it anyway, the mv below would nest the node's data inside it.
      if [ -e "$PROJECT_DIR/data" ] || [ -L "$PROJECT_DIR/data" ]; then
        echo "🛑 FATAL: the new code brought its own $PROJECT_DIR/data. This node's data is safe at $HOME_DIR/beanpool-data-backup-$DIR;"
        echo "    set the new data/ aside under a dated name and deploy again."; exit 1
      fi
      sudo mv "$HOME_DIR/beanpool-data-backup-$DIR" "$PROJECT_DIR/data" || {
        echo "🛑 FATAL: data/ is preserved at $HOME_DIR/beanpool-data-backup-$DIR but could not be restored."
        echo "    Put it back by hand before starting the node (sudo mv $HOME_DIR/beanpool-data-backup-$DIR $PROJECT_DIR/data),"
        echo "    or fix the cause and deploy again: a deploy puts a parked copy back when nothing is in its place."; exit 1; }
    fi
    if [ -e "$HOME_DIR/beanpool-env-backup-$DIR" ] || [ -L "$HOME_DIR/beanpool-env-backup-$DIR" ]; then
      if [ -e "$PROJECT_DIR/.env" ] || [ -L "$PROJECT_DIR/.env" ]; then
        echo "🛑 FATAL: the new code brought its own $PROJECT_DIR/.env. This node's is safe at $HOME_DIR/beanpool-env-backup-$DIR;"
        echo "    set the new .env aside under a dated name and deploy again."; exit 1
      fi
      sudo mv "$HOME_DIR/beanpool-env-backup-$DIR" "$PROJECT_DIR/.env" || {
        echo "🛑 FATAL: .env is preserved at $HOME_DIR/beanpool-env-backup-$DIR but could not be restored."; exit 1; }
    fi
    # --- END preserve/restore ---
    cd $PROJECT_DIR
    export PUBLIC_IP=\$(curl -s -4 ifconfig.me)  # IPv4: an IPv6-first host answered with its v6 address (global node, 2026-09-25)
    export CF_RECORD_NAME='${DNS}'
    ${DEPLOY_TAG:+export BEANPOOL_IMAGE_TAG='${DEPLOY_TAG}'}
    # No Cloudflare token, no shared admin password and no fleet tunnel token reach this server (FLEET SECRETS in
    # scripts/deploy-lib.sh). These remove what earlier deploys and hand edits left, naming what they remove, never a value.
    strip_fleet_secrets_env "$PROJECT_DIR/.env"
    remove_fleet_tunnel_token "$PROJECT_DIR/data/tunnel-token" "$FLEET_TUNNEL_SHA"
    sudo mkdir -p $PROJECT_DIR/data
    if [ "$DIR" = "BeanPool-Review" ]; then
      # Review node (VIC): tunnel-only HTTPS on 8447
      sed -i 's/\"80:8080\"/\"8083:8080\"/g' docker-compose.yml
      sed -i 's/\"443:8443\"/\"8447:8443\"/g' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
      sed -i '/\"8443:8443\"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Castlemaine" ]; then
      # Castlemaine node (VIC host tunnel): HTTP 8081, HTTPS 8445
      sed -i 's/"80:8080"/"8081:8080"/g' docker-compose.yml
      sed -i 's/"443:8443"/"8445:8443"/g' docker-compose.yml
      sed -i '/"8080:8080"/d' docker-compose.yml
      sed -i '/"8443:8443"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Bris" ]; then
      # Bris node (QLD): tunnel-only HTTPS on 8443
      sed -i '/\"8443:8443\"/d' docker-compose.yml
      sed -i 's/\"443:8443\"/\"8443:8443\"/g' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Mullum" ]; then
      # Mullum node (QLD): tunnel-only HTTPS on 8445
      sed -i 's/\"80:8080\"/\"8081:8080\"/g' docker-compose.yml
      sed -i 's/\"443:8443\"/\"8445:8443\"/g' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
      sed -i '/\"8443:8443\"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Test" ]; then
      # Test node (QLD): tunnel-only HTTPS on 8446
      sed -i 's/\"80:8080\"/\"8082:8080\"/g' docker-compose.yml
      sed -i 's/\"443:8443\"/\"8446:8443\"/g' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
      sed -i '/\"8443:8443\"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Gippsland" ]; then
      sed -i 's/\"80:8080\"/\"8084:8080\"/g' docker-compose.yml
      sed -i 's/\"443:8443\"/\"8448:8443\"/g' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
      sed -i '/\"8443:8443\"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-EastGippy" ]; then
      sed -i 's/\"80:8080\"/\"8085:8080\"/g' docker-compose.yml
      sed -i 's/\"443:8443\"/\"8450:8443\"/g' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
      sed -i '/\"8443:8443\"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Bindarrabi" ]; then
      sed -i 's/"80:8080"/"8086:8080"/g' docker-compose.yml
      sed -i 's/"443:8443"/"8451:8443"/g' docker-compose.yml
      sed -i '/"8080:8080"/d' docker-compose.yml
      sed -i '/"8443:8443"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-YarraValley" ]; then
      sed -i 's/"80:8080"/"8087:8080"/g' docker-compose.yml
      sed -i 's/"443:8443"/"8452:8443"/g' docker-compose.yml
      sed -i '/"8080:8080"/d' docker-compose.yml
      sed -i '/"8443:8443"/d' docker-compose.yml
    fi
    if [ "$NAME" = "mullum1" ]; then
      sed -i '/"80:8080"/d' docker-compose.yml
      sed -i '/"443:8443"/d' docker-compose.yml
      sed -i '/"8080:8080"/d' docker-compose.yml
      sed -i '/"8443:8443"/d' docker-compose.yml
    fi
    echo "Public IP: $PUBLIC_IP"
    echo "DNS Record: $CF_RECORD_NAME"
    if [ -n "${DEPLOY_TAG:-}" ]; then
      echo "Image Tag: ${DEPLOY_TAG}"
    fi
    first_password_notice "$PROJECT_DIR/data" "$USER@$IP"
    # The node starts only on its own data, back in place: never while a parked copy is still waiting to go back.
    if [ -e "$HOME_DIR/beanpool-data-backup-$DIR" ] || [ -e "$HOME_DIR/beanpool-env-backup-$DIR" ]; then
      echo "🛑 FATAL: a parked copy of this node's data/ or .env is still in $HOME_DIR. Not starting the node on anything else."
      exit 1
    fi
    sudo docker image prune -f 2>/dev/null || true
    sudo docker network create beanpool-shared 2>/dev/null || true
    # No server of ours starts the compose cloudflared sidecar (the tunnel profile) any more: every one is reached through its
    # host's own tunnel (qld, vic, global), and the sidecar only ran the fleet token, whose tunnel no longer exists. The
    # down with the tunnel profile above still stops a sidecar an earlier deploy started.
    # Build on the target host by default, which is why every name below is listed: the running image is then
    # guaranteed to be the code in the tarball we just uploaded, uncommitted work included.
    #
    # DEPLOY_PULL=1 takes the published GHCR image instead. That drops the guarantee — you get whatever CI last
    # pushed (by default :latest, which only updates on release; pass DEPLOY_TAG=<sha> for main builds), NOT your
    # working tree — so it is only correct when the commit you want is already built and pushed. What it buys is
    # not building a monorepo on a small host: the VIC box is 1.3 GB and runs six nodes, so a build there leans
    # on swap and competes with communities that have live members.
    #
    # It is opt-in per run, not per node, because the choice depends on the state of your tree at that moment
    # rather than on which node you are deploying to.
    if [ "${DEPLOY_PULL:-}" = "1" ]; then
      if [ -z "${DEPLOY_TAG:-}" ]; then
        echo "⚠️  WARNING: :latest is the last RELEASE, not main — pass DEPLOY_TAG=<sha> to deploy a commit from main"
      fi
      echo "📦 DEPLOY_PULL=1 — taking the published image (${DEPLOY_TAG:-latest}) for: $NAME (NOT your working tree)"
      sudo -E docker compose -p $PROJ_NAME pull || {
        echo "🛑 FATAL: docker compose pull failed for image ${IMAGE} on $NAME."
        echo "⚠️  WARNING: Node container for $NAME is currently STOPPED."
        echo "   To retry:   ssh $USER@$IP 'cd $PROJECT_DIR && sudo docker compose pull && sudo docker compose up -d'"
        echo "   To restore: ssh $USER@$IP 'cd $PROJECT_DIR && sudo docker compose up -d'"
        exit 1
      }
      sudo -E docker compose -p $PROJ_NAME up -d
    elif [ "$NAME" = "test" ] || [ "$NAME" = "review" ] || [ "$NAME" = "mullum1" ] || [ "$NAME" = "melb" ] || [ "$NAME" = "castlemaine" ] || [ "$NAME" = "bris" ] || [ "$NAME" = "mullum" ] || [ "$NAME" = "gippsland" ] || [ "$NAME" = "eastgippy" ] || [ "$NAME" = "bindarrabi" ] || [ "$NAME" = "yarravalley" ]; then
      echo "🔨 Local build enabled for target: $NAME"
      sudo -E docker compose -p $PROJ_NAME up -d --build
    else
      sudo -E docker compose -p $PROJ_NAME pull || {
        echo "🛑 FATAL: docker compose pull failed for image ${IMAGE} on $NAME."
        echo "⚠️  WARNING: Node container for $NAME is currently STOPPED."
        echo "   To retry:   ssh $USER@$IP 'cd $PROJECT_DIR && sudo docker compose pull && sudo docker compose up -d'"
        echo "   To restore: ssh $USER@$IP 'cd $PROJECT_DIR && sudo docker compose up -d'"
        exit 1
      }
      sudo -E docker compose -p $PROJ_NAME up -d
    fi

    CONTAINER_ID=\$(sudo docker compose -p $PROJ_NAME ps -q beanpool-node 2>/dev/null | head -n1)
    if [ -n "\$CONTAINER_ID" ]; then
      IMAGE_ID=\$(sudo docker inspect --format '{{.Image}}' "\$CONTAINER_ID" 2>/dev/null)
      REPO_TAG=\$(sudo docker inspect --format '{{.Config.Image}}' "\$CONTAINER_ID" 2>/dev/null)
      REVISION=\$(sudo docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "\$CONTAINER_ID" 2>/dev/null)
      DIGEST=\$(sudo docker inspect --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}' "\$IMAGE_ID" 2>/dev/null)
      echo "📋 Started container details for $NAME:"
      echo "   Container: \$CONTAINER_ID"
      echo "   Image:     \${REPO_TAG:-\$IMAGE_ID}"
      echo "   Digest:    \${DIGEST:-\$IMAGE_ID}"
      if [ -n "\$REVISION" ]; then
        echo "   Revision:  \$REVISION"
      fi
    fi
EOF

  if [ "$REMOTE_RC" -eq 3 ]; then
    echo "❌ $NAME: aborted before touching the running container (see above)."
    FAILED_NODES+=("$NAME (aborted, old container still running)"); FAILED_HOSTS+=("$USER@$IP")
    echo ""
    continue
  fi
  if [ "$REMOTE_RC" -eq 4 ]; then
    echo "❌ $NAME: another deploy of this node is running on $USER@$IP. Nothing was changed; this run leaves that host alone."
    FAILED_NODES+=("$NAME (another deploy was running; nothing changed)"); FAILED_HOSTS+=("$USER@$IP"); BUSY_HOSTS+=("$USER@$IP")
    echo ""
    continue
  fi
  # The image label says what was started, not that it runs. Only a node that answers counts as deployed.
  HEALTH_URL="https://$DNS$HEALTH_PATH"
  if [ "$REMOTE_RC" -eq 0 ] && wait_node_healthy "$NAME" "$HEALTH_URL" "$HEALTH_TIMEOUT" remote_node_state; then
    echo "✅ $NAME deployed! (container $HEALTH_STATUS, restarts $HEALTH_RESTARTS, $HEALTH_URL → $HEALTH_CODE)"
    OK_NODES+=("$NAME")
  else
    if [ "$REMOTE_RC" -ne 0 ]; then
      echo "   The remote deploy step exited $REMOTE_RC after the old container was stopped."
      STATE=$(remote_node_state); HEALTH_STATUS=${STATE%% *}; HEALTH_RESTARTS=${STATE##* }
      HEALTH_CODE=$(http_status "$HEALTH_URL")
    fi
    echo "❌ $NAME is NOT healthy: container ${HEALTH_STATUS:-unknown}, restarts ${HEALTH_RESTARTS:-?}, $HEALTH_URL → ${HEALTH_CODE:-000}"
    echo "   Last 30 log lines:"
    ssh $SSH_OPTS $USER@$IP "C=\$(sudo docker ps -aq --filter label=com.docker.compose.project=$PROJ_NAME --filter label=com.docker.compose.service=beanpool-node | head -n1); [ -n \"\$C\" ] && sudo docker logs --tail 30 \"\$C\" 2>&1" 2>/dev/null | sed 's/^/   | /' || true
    echo "   Skipping the image prune on $USER@$IP so the previous image stays local for a rollback."
    FAILED_NODES+=("$NAME (unhealthy)"); FAILED_HOSTS+=("$USER@$IP")
  fi
  echo ""
done

# Clean up build caches and drop caches on each unique host deployed to
echo "🧹 Running post-deployment memory and build cache cleanup..."
UNIQUE_HOSTS=$(for NODE in "${TARGETS[@]}"; do
  IP=$(echo "$NODE" | cut -d: -f3)
  USER=$(echo "$NODE" | cut -d: -f5)
  echo "$USER@$IP"
done | sort -u)

for HOST in $UNIQUE_HOSTS; do
  USER=$(echo "$HOST" | cut -d@ -f1)
  IP=$(echo "$HOST" | cut -d@ -f2)
  if [ "$USER" = "azureuser" ]; then
    SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes -i ~/.ssh/id_azure_lattice"
  else
    SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes"
  fi
  # Every DEPLOY_TAG pull leaves a TAGGED 1.2 GB image, and image prune -f / system prune -f only remove
  # dangling ones — 30 of them filled qld's 40 GB disk on 2026-09-19. prune -a removes every image no
  # container uses and keeps every image a container does, other nodes' on this host included. It is skipped
  # on a host where any node failed, so that node's previous image stays local; otherwise a rollback is a
  # re-pull of its tag from ghcr.
  PRUNE_IMAGES=1
  for F in "${FAILED_HOSTS[@]+"${FAILED_HOSTS[@]}"}"; do
    [ "$F" = "$HOST" ] && PRUNE_IMAGES=0
  done
  # A deploy that is running there right now needs its new image and its build cache: leave the host alone.
  BUSY=0
  for F in "${BUSY_HOSTS[@]+"${BUSY_HOSTS[@]}"}"; do
    [ "$F" = "$HOST" ] && BUSY=1
  done
  if [ "$BUSY" = "1" ]; then
    echo "   Skipping cleanup on $HOST: another deploy is running there."
    continue
  fi
  if [ "$PRUNE_IMAGES" = "1" ]; then
    echo "   Cleaning up caches and unused images on $HOST..."
  else
    echo "   Cleaning up caches on $HOST (NOT pruning images: a node on this host failed, its rollback image stays)..."
  fi
  ssh $SSH_OPTS $USER@$IP "/bin/bash" << EOF || echo "   ⚠️  cleanup on $HOST did not finish cleanly"
    if [ "$PRUNE_IMAGES" = "1" ]; then
      echo "   Disk before image prune: \$(df -h / | awk 'NR==2 {print \$4" free of "\$2}')"
      echo "   🧹 docker image prune -a -f: \$(sudo docker image prune -a -f 2>&1 | grep -i 'reclaimed' || echo 'nothing to remove')"
      echo "   Disk after image prune:  \$(df -h / | awk 'NR==2 {print \$4" free of "\$2}')"
    fi
    sudo docker builder prune -a -f 2>/dev/null || true
    sudo docker system prune -f 2>/dev/null || true
    sudo journalctl --vacuum-time=1d 2>/dev/null || true
    sync && echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null || true
EOF
done

rm -f /tmp/beanpool-deploy.tar.gz
echo ""
if [ ${#FAILED_NODES[@]} -eq 0 ]; then
  echo "🎉 All ${#TARGETS[@]} node(s) deployed and answering!"
  exit 0
fi
echo "❌ ${#FAILED_NODES[@]} of ${#TARGETS[@]} node(s) failed:"
for F in "${FAILED_NODES[@]}"; do echo "   - $F"; done
if [ ${#OK_NODES[@]} -gt 0 ]; then
  echo "✅ Deployed and answering: ${OK_NODES[*]}"
fi
exit 1

