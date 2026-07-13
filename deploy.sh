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
echo "📦 Packaging deploy config..."
tar -czf /tmp/beanpool-deploy.tar.gz \
    --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='.turbo' \
    --exclude='.next' --exclude='out' --exclude='archive' --exclude='apps/native' --exclude='apps/native.bak' \
    --exclude='*.apk' --exclude='data' --exclude='.env' --exclude='.env.*' --exclude='builds' \
    -C "$SCRIPT_DIR" .
echo "✅ Package ready: $(du -h /tmp/beanpool-deploy.tar.gz | cut -f1)"

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
  PROJ_NAME=$(echo "beanpool-$DIR" | tr '[:upper:]' '[:lower:]')

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
  scp $SSH_OPTS /tmp/beanpool-deploy.tar.gz $USER@$IP:$HOME_DIR/

  # Stop, preserve data, extract, pull image, start
  ssh $SSH_OPTS $USER@$IP "/bin/bash" << EOF
    cd $PROJECT_DIR 2>/dev/null && sudo docker compose -p \$PROJ_NAME down 2>/dev/null
    sudo mv $PROJECT_DIR/data $HOME_DIR/beanpool-data-backup-$DIR 2>/dev/null || true
    sudo mv $PROJECT_DIR/.env $HOME_DIR/beanpool-env-backup-$DIR 2>/dev/null || true
    sudo rm -rf $PROJECT_DIR
    mkdir -p $PROJECT_DIR
    tar -xzf $HOME_DIR/beanpool-deploy.tar.gz -C $PROJECT_DIR
    sudo mv $HOME_DIR/beanpool-data-backup-$DIR $PROJECT_DIR/data 2>/dev/null || true
    sudo mv $HOME_DIR/beanpool-env-backup-$DIR $PROJECT_DIR/.env 2>/dev/null || true
    cd $PROJECT_DIR
    export PUBLIC_IP=\$(curl -s ifconfig.me)
    export CF_API_TOKEN='${CF_API_TOKEN}'
    export CF_ZONE_ID='${CF_ZONE_ID}'
    export CF_RECORD_NAME='${DNS}'
    export ADMIN_PASSWORD='${ADMIN_PASSWORD}'
    export CF_TUNNEL_TOKEN='${CF_TUNNEL_TOKEN}'
    if [ "$DIR" = "BeanPool-Review" ]; then
      # Review node (VIC): tunnel-only
      sed -i 's/\"80:8080\"/\"8083:8080\"/g' docker-compose.yml
      sed -i '/\"443:8443\"/d' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
      sed -i '/\"8443:8443\"/d' docker-compose.yml
      sed -i '/\"4001:4001\"/d' docker-compose.yml
      sed -i '/\"4002:4002\"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Castlemaine" ]; then
      sed -i 's/\"80:8080\"/\"8081:8080\"/g' docker-compose.yml
      sed -i 's/\"443:8443\"/\"8445:8443\"/g' docker-compose.yml
      sed -i 's/\"8080:8080\"/\"8082:8080\"/g' docker-compose.yml
      sed -i 's/\"8443:8443\"/\"8446:8443\"/g' docker-compose.yml
      sed -i 's/\"4001:4001\"/\"4004:4001\"/g' docker-compose.yml
      sed -i 's/\"4002:4002\"/\"4005:4002\"/g' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Bris" ]; then
      # Bris node (QLD): tunnel-only, default port 8080
      sed -i '/\"443:8443\"/d' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
      sed -i '/\"8443:8443\"/d' docker-compose.yml
      sed -i '/\"4001:4001\"/d' docker-compose.yml
      sed -i '/\"4002:4002\"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Mullum" ]; then
      # Mullum node (QLD): tunnel-only
      sed -i 's/\"80:8080\"/\"8081:8080\"/g' docker-compose.yml
      sed -i '/\"443:8443\"/d' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
      sed -i '/\"8443:8443\"/d' docker-compose.yml
      sed -i '/\"4001:4001\"/d' docker-compose.yml
      sed -i '/\"4002:4002\"/d' docker-compose.yml
    elif [ "$DIR" = "BeanPool-Test" ]; then
      # Test node (QLD): tunnel-only
      sed -i 's/\"80:8080\"/\"8082:8080\"/g' docker-compose.yml
      sed -i '/\"443:8443\"/d' docker-compose.yml
      sed -i '/\"8080:8080\"/d' docker-compose.yml
      sed -i '/\"8443:8443\"/d' docker-compose.yml
      sed -i '/\"4001:4001\"/d' docker-compose.yml
      sed -i '/\"4002:4002\"/d' docker-compose.yml
    fi
    if [ "$NAME" = "mullum1" ]; then
      sed -i '/"80:8080"/d' docker-compose.yml
      sed -i '/"443:8443"/d' docker-compose.yml
      sed -i '/"8080:8080"/d' docker-compose.yml
      sed -i '/"8443:8443"/d' docker-compose.yml
    fi
    echo \"Public IP: \$PUBLIC_IP\"
    echo \"DNS Record: \$CF_RECORD_NAME\"
    sudo docker image prune -f 2>/dev/null || true
    sudo docker network create beanpool-shared 2>/dev/null || true
    COMPOSE_FLAGS=()
    if [ -n "\$CF_TUNNEL_TOKEN" ] && [ "\$NAME" = "mullum1" ]; then
      COMPOSE_FLAGS=(--profile tunnel)
    fi
    if [ "$NAME" = "test" ] || [ "$NAME" = "review" ] || [ "$NAME" = "mullum1" ] || [ "$NAME" = "melb" ] || [ "$NAME" = "castlemaine" ] || [ "$NAME" = "bris" ] || [ "$NAME" = "mullum" ]; then
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

rm -f /tmp/beanpool-deploy.tar.gz
echo "🎉 All ${#TARGETS[@]} node(s) deployed!"

