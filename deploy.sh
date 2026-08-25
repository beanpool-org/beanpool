#!/bin/bash
set -e

# BeanPool Global Mesh Deploy Script
# Pulls pre-built image from GHCR and deploys to remote nodes
#
# Usage:
#   bash deploy.sh           # Deploy to all nodes
#   bash deploy.sh 1 3 4     # Deploy to specific nodes by number
#
# The Docker image is auto-built by GitHub Actions on push to main:
#   ghcr.io/beanpool-org/beanpool-node:latest

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="ghcr.io/beanpool-org/beanpool-node:latest"

# Load .env file for Cloudflare credentials (if it exists)
if [ -f "$SCRIPT_DIR/.env" ]; then
  echo "🔑 Loading .env file..."
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
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

# Package docker-compose.yml + data-preserving deploy config
PKG_PATH="$SCRIPT_DIR/.deploy-package.tar.gz"
echo "📦 Packaging deploy config..."
tar -czf "$PKG_PATH" \
    --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='.turbo' \
    --exclude='.next' --exclude='out' --exclude='archive' --exclude='apps/native' --exclude='apps/native.bak' \
    --exclude='*.apk' --exclude='data' --exclude='.env' --exclude='.env.*' --exclude='builds' \
    --exclude='.deploy-package.tar.gz' \
    -C "$SCRIPT_DIR" .
echo "✅ Package ready: $(du -h "$PKG_PATH" | cut -f1)"

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
echo "🌍 Deploying to ${#TARGETS[@]} node(s):"
for NODE in "${TARGETS[@]}"; do
  NAME=$(echo "$NODE" | cut -d: -f2)
  IP=$(echo "$NODE" | cut -d: -f3)
  DNS=$(echo "$NODE" | cut -d: -f4)
  echo "   $NAME ($IP) → $DNS"
done
echo ""

# Deploy each node
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
  if [ "$USER" = "azureuser" ]; then
    SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes -i ~/.ssh/id_azure_lattice"
  else
    SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes"
  fi

  echo "====================================="
  echo "🚀 Deploying $NAME ($IP) → $DNS"
  echo "====================================="

  # Upload
  scp $SSH_OPTS "$PKG_PATH" $USER@$IP:$HOME_DIR/beanpool-deploy.tar.gz

  # Stop, preserve data, extract, pull image, start
  ssh $SSH_OPTS $USER@$IP "/bin/bash" << EOF
    cd $PROJECT_DIR 2>/dev/null && (
      sudo docker rm -f $PROJ_NAME-beanpool-node-1 2>/dev/null || true
      sudo docker rm -f beanpool-$PROJ_NAME-beanpool-node-1 2>/dev/null || true
      sudo docker rm -f beanpool-beanpool-$NAME-beanpool-node-1 2>/dev/null || true
      sudo docker compose --profile tunnel -p \$PROJ_NAME down --remove-orphans 2>/dev/null || true
      sudo docker compose --profile tunnel -p beanpool-\$PROJ_NAME down --remove-orphans 2>/dev/null || true
      sleep 1
    )
    # --- BEGIN preserve/restore (scripts/test-deploy-preserve.sh extracts and runs this exact block) ---
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
    # Two rules now: the destination is guaranteed not to exist before each move, and failing to
    # preserve or restore data/ is FATAL. Continuing past that would wipe a node's identity keys
    # and ledger, which is not something to shrug off.
    if [ -e "$HOME_DIR/beanpool-data-backup-$DIR" ]; then
      echo "⚠️  Stale backup found at $HOME_DIR/beanpool-data-backup-$DIR — a previous deploy did not finish."
      echo "    The live data/ is authoritative, so parking the stale copy at .stale (outside the project dir)."
      sudo rm -rf "$HOME_DIR/beanpool-data-backup-$DIR.stale"
      sudo mv "$HOME_DIR/beanpool-data-backup-$DIR" "$HOME_DIR/beanpool-data-backup-$DIR.stale"
    fi
    if [ -d "$PROJECT_DIR/data" ]; then
      sudo mv "$PROJECT_DIR/data" "$HOME_DIR/beanpool-data-backup-$DIR" || {
        echo "🛑 FATAL: could not preserve $PROJECT_DIR/data — refusing to wipe the project dir."; exit 1; }
    fi
    if [ -e "$PROJECT_DIR/.env" ]; then
      sudo rm -rf "$HOME_DIR/beanpool-env-backup-$DIR"
      sudo mv "$PROJECT_DIR/.env" "$HOME_DIR/beanpool-env-backup-$DIR" || {
        echo "🛑 FATAL: could not preserve $PROJECT_DIR/.env — refusing to wipe the project dir."; exit 1; }
    fi
    sudo rm -rf $PROJECT_DIR
    mkdir -p $PROJECT_DIR
    tar -xzf $HOME_DIR/beanpool-deploy.tar.gz -C $PROJECT_DIR
    if [ -e "$HOME_DIR/beanpool-data-backup-$DIR" ]; then
      # The tarball excludes data/, but be explicit — if this exists, the mv below nests inside it.
      sudo rm -rf "$PROJECT_DIR/data"
      sudo mv "$HOME_DIR/beanpool-data-backup-$DIR" "$PROJECT_DIR/data" || {
        echo "🛑 FATAL: data/ is preserved at $HOME_DIR/beanpool-data-backup-$DIR but could not be restored."
        echo "    Restore it by hand before starting the node — do NOT re-run the deploy."; exit 1; }
    fi
    if [ -e "$HOME_DIR/beanpool-env-backup-$DIR" ]; then
      sudo rm -rf "$PROJECT_DIR/.env"
      sudo mv "$HOME_DIR/beanpool-env-backup-$DIR" "$PROJECT_DIR/.env" || {
        echo "🛑 FATAL: .env is preserved at $HOME_DIR/beanpool-env-backup-$DIR but could not be restored."; exit 1; }
    fi
    # --- END preserve/restore ---
    cd $PROJECT_DIR
    export PUBLIC_IP=\$(curl -s ifconfig.me)
    export CF_API_TOKEN='${CF_API_TOKEN}'
    export CF_ZONE_ID='${CF_ZONE_ID}'
    export CF_RECORD_NAME='${DNS}'
    export ADMIN_PASSWORD='${ADMIN_PASSWORD}'
    export CF_TUNNEL_TOKEN='${CF_TUNNEL_TOKEN}'
    sudo mkdir -p $PROJECT_DIR/data
    if [ -n "\$CF_TUNNEL_TOKEN" ]; then
      echo "\$CF_TUNNEL_TOKEN" | sudo tee $PROJECT_DIR/data/tunnel-token > /dev/null
    fi
    if [ -f "$PROJECT_DIR/data/tunnel-token" ]; then
      sudo chmod 644 $PROJECT_DIR/data/tunnel-token
    fi
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
    sudo docker image prune -f 2>/dev/null || true
    sudo docker network create beanpool-shared 2>/dev/null || true
    COMPOSE_FLAGS=()
    if [ "$NAME" = "test" ] || [ "$NAME" = "yarravalley" ]; then
      COMPOSE_FLAGS=(--profile tunnel)
    fi
    # Build on the target host by default, which is why every name below is listed: the running image is then
    # guaranteed to be the code in the tarball we just uploaded, uncommitted work included.
    #
    # DEPLOY_PULL=1 takes the published GHCR image instead. That drops the guarantee — you get whatever CI last
    # pushed to :latest, NOT your working tree — so it is only correct when the commit you want is already built
    # and pushed. What it buys is not building a monorepo on a small host: the VIC box is 1.3 GB and runs six
    # nodes, so a build there leans on swap and competes with communities that have live members.
    #
    # It is opt-in per run, not per node, because the choice depends on the state of your tree at that moment
    # rather than on which node you are deploying to.
    if [ "${DEPLOY_PULL:-}" = "1" ]; then
      echo "📦 DEPLOY_PULL=1 — taking the published image for: $NAME (NOT your working tree)"
      sudo -E docker compose "\${COMPOSE_FLAGS[@]}" -p $PROJ_NAME pull
      sudo -E docker compose "\${COMPOSE_FLAGS[@]}" -p $PROJ_NAME up -d
    elif [ "$NAME" = "test" ] || [ "$NAME" = "review" ] || [ "$NAME" = "mullum1" ] || [ "$NAME" = "melb" ] || [ "$NAME" = "castlemaine" ] || [ "$NAME" = "bris" ] || [ "$NAME" = "mullum" ] || [ "$NAME" = "gippsland" ] || [ "$NAME" = "eastgippy" ] || [ "$NAME" = "bindarrabi" ] || [ "$NAME" = "yarravalley" ]; then
      echo "🔨 Local build enabled for target: $NAME"
      sudo -E docker compose "\${COMPOSE_FLAGS[@]}" -p $PROJ_NAME up -d --build
    else
      sudo -E docker compose "\${COMPOSE_FLAGS[@]}" -p $PROJ_NAME pull
      sudo -E docker compose "\${COMPOSE_FLAGS[@]}" -p $PROJ_NAME up -d
    fi
EOF

  echo "✅ $NAME deployed!"
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
    SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes -i ~/.ssh/id_azure_lattice"
  else
    SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes"
  fi
  echo "   Cleaning up caches on $HOST..."
  ssh $SSH_OPTS $USER@$IP "/bin/bash" << EOF
    sudo docker builder prune -a -f 2>/dev/null || true
    sudo docker system prune -f 2>/dev/null || true
    sudo journalctl --vacuum-time=1d 2>/dev/null || true
    sync && echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null || true
EOF
done

rm -f /tmp/beanpool-deploy.tar.gz
echo "🎉 All ${#TARGETS[@]} node(s) deployed!"

