#!/usr/bin/env bash
set -eo pipefail

# BeanPool Node Environment Rotation Tool
# Updates .env variables on remote nodes over SSH and restarts only the beanpool-node container.
#
# Usage:
#   bash scripts/rotate-node-env.sh --nodes test,review KEY1=VALUE1 KEY2=VALUE2
#   bash scripts/rotate-node-env.sh --dry-run 11 KEY=VALUE
#   bash scripts/rotate-node-env.sh --nodes test --env-file secret.env
#   cat secret.env | bash scripts/rotate-node-env.sh --nodes test -

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGETS_CONF="$REPO_ROOT/deploy-targets.conf"

DRY_RUN=0
TARGET_NODES=()
KEY_VALUE_PAIRS=()
ENV_FILE=""
READ_STDIN=0
FORCE_LIVE_NODE=0

usage() {
  cat << 'EOF'
BeanPool Node Environment Rotation Tool

Usage:
  bash scripts/rotate-node-env.sh [OPTIONS] [NODE_OR_KEY_VALUE...]

Options:
  -n, --dry-run             Simulate changes without modifying .env or restarting containers
  -N, --node <id_or_name>   Target specific node (can be specified multiple times)
      --nodes <list>        Comma-separated list of target node IDs or names (e.g. test,review)
  -f, --env-file <path>     Read KEY=VALUE pairs from a file
      --force-live-node     Explicitly allow updating live community node (mullum)
  -h, --help                Show this help message

Arguments:
  KEY=VALUE                 One or more environment variable pairs to set/update
  <id_or_name>              Target node ID (e.g. 11) or name (e.g. test)
  -                         Read KEY=VALUE pairs from standard input

Security Guarantees:
  • No secret values are ever echoed, printed, or passed on remote process arguments.
  • Secrets are streamed directly over SSH stdin to an atomic update handler.
  • Remote .env permissions are strictly enforced to 0600.
  • Only the beanpool-node container is restarted; cloudflared tunnel sidecars are untouched.

Available Nodes (from deploy-targets.conf):
EOF
  if [ -f "$TARGETS_CONF" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ -z "${line//[[:space:]]/}" ]] && continue
      nid=$(echo "$line" | cut -d: -f1)
      nname=$(echo "$line" | cut -d: -f2)
      nhost=$(echo "$line" | cut -d: -f3)
      ndns=$(echo "$line" | cut -d: -f4)
      echo "  [$nid] $nname ($nhost -> $ndns)"
    done < "$TARGETS_CONF"
  else
    echo "  (deploy-targets.conf not found)"
  fi
  exit 0
}

# Parse command-line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      ;;
    -n|--dry-run)
      DRY_RUN=1
      shift
      ;;
    -N|--node)
      if [ -z "${2:-}" ]; then
        echo "Error: --node requires an argument" >&2
        exit 1
      fi
      TARGET_NODES+=("$2")
      shift 2
      ;;
    --nodes)
      if [ -z "${2:-}" ]; then
        echo "Error: --nodes requires an argument" >&2
        exit 1
      fi
      IFS=',' read -ra ADDR <<< "$2"
      for n in "${ADDR[@]}"; do
        TARGET_NODES+=("$(echo "$n" | xargs)")
      done
      shift 2
      ;;
    -f|--env-file)
      if [ -z "${2:-}" ] || [ ! -f "$2" ]; then
        echo "Error: --env-file requires a valid file path" >&2
        exit 1
      fi
      ENV_FILE="$2"
      shift 2
      ;;
    --force-live-node)
      FORCE_LIVE_NODE=1
      shift
      ;;
    -)
      READ_STDIN=1
      shift
      ;;
    *)
      if [[ "$1" =~ ^[A-Za-z0-9_]+= ]]; then
        KEY_VALUE_PAIRS+=("$1")
      else
        TARGET_NODES+=("$1")
      fi
      shift
      ;;
  esac
done

# Read from file if specified
if [ -n "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[A-Za-z0-9_]+= ]]; then
      KEY_VALUE_PAIRS+=("$line")
    fi
  done < "$ENV_FILE"
fi

# Read from stdin if requested or if piped
if [ $READ_STDIN -eq 1 ] || { [ ! -t 0 ] && [ ${#KEY_VALUE_PAIRS[@]} -eq 0 ]; }; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[A-Za-z0-9_]+= ]]; then
      KEY_VALUE_PAIRS+=("$line")
    fi
  done
fi

# Validate key-value pairs
if [ ${#KEY_VALUE_PAIRS[@]} -eq 0 ]; then
  echo "❌ Error: No KEY=VALUE pairs provided to rotate." >&2
  echo "Pass pairs as arguments, via --env-file, or via stdin." >&2
  exit 1
fi

# Validate target nodes
if [ ${#TARGET_NODES[@]} -eq 0 ]; then
  echo "❌ Error: No target node(s) specified." >&2
  echo "Specify target nodes using --node, --nodes, or node name/ID arguments." >&2
  exit 1
fi

# Load node registry from deploy-targets.conf
ALL_NODES=()
if [ -f "$TARGETS_CONF" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line//[[:space:]]/}" ]] && continue
    ALL_NODES+=("$line")
  done < "$TARGETS_CONF"
else
  echo "❌ Error: deploy-targets.conf not found at $TARGETS_CONF" >&2
  exit 1
fi

# Resolve matching nodes
RESOLVED_TARGETS=()
for TARGET in "${TARGET_NODES[@]}"; do
  MATCHED=0
  for NODE_DEF in "${ALL_NODES[@]}"; do
    N_ID=$(echo "$NODE_DEF" | cut -d: -f1)
    N_NAME=$(echo "$NODE_DEF" | cut -d: -f2)
    if [ "$TARGET" = "$N_ID" ] || [ "$TARGET" = "$N_NAME" ]; then
      RESOLVED_TARGETS+=("$NODE_DEF")
      MATCHED=1
      break
    fi
  done
  if [ $MATCHED -eq 0 ]; then
    echo "⚠️ Warning: Target '$TARGET' not found in deploy-targets.conf — skipping" >&2
  fi
done

if [ ${#RESOLVED_TARGETS[@]} -eq 0 ]; then
  echo "❌ Error: None of the specified targets could be resolved." >&2
  exit 1
fi

echo "=========================================================="
if [ $DRY_RUN -eq 1 ]; then
  echo "🔍 DRY RUN: Simulating .env update (no files or containers modified)"
else
  echo "🔐 ROTATING NODE ENVIRONMENT"
fi
echo "Target nodes: ${#RESOLVED_TARGETS[@]}"
echo "Keys to rotate: ${#KEY_VALUE_PAIRS[@]}"
for pair in "${KEY_VALUE_PAIRS[@]}"; do
  k=$(echo "$pair" | cut -d= -f1)
  v=$(echo "$pair" | cut -d= -f2-)
  echo "  • $k (length: ${#v} chars)"
done
echo "=========================================================="
echo ""

# Execution loop
FAILED_NODES=()

for NODE_DEF in "${RESOLVED_TARGETS[@]}"; do
  N_ID=$(echo "$NODE_DEF" | cut -d: -f1)
  N_NAME=$(echo "$NODE_DEF" | cut -d: -f2)
  N_HOST=$(echo "$NODE_DEF" | cut -d: -f3)
  N_DNS=$(echo "$NODE_DEF" | cut -d: -f4)
  N_USER=$(echo "$NODE_DEF" | cut -d: -f5)
  N_DIR=$(echo "$NODE_DEF" | cut -d: -f6)

  if [ -z "$N_DIR" ]; then N_DIR="BeanPool"; fi
  if [ "$N_USER" = "root" ]; then
    N_HOME="/root"
  else
    N_HOME="/home/$N_USER"
  fi
  PROJECT_DIR="$N_HOME/$N_DIR"
  PROJ_NAME=$(echo "$N_DIR" | tr '[:upper:]' '[:lower:]')

  echo "━━━ [$N_ID] $N_NAME ($N_HOST -> $N_DNS) ━━━"

  # Live community safety check
  if [ "$N_NAME" = "mullum" ] || [ "$N_ID" = "10" ]; then
    if [ $FORCE_LIVE_NODE -ne 1 ]; then
      echo "🛑 PROTECTING LIVE NODE: '$N_NAME' is a live community!"
      echo "   Skipping. To force rotation on this node, pass --force-live-node."
      FAILED_NODES+=("$N_NAME (skipped: live node)")
      echo ""
      continue
    else
      echo "⚠️ CAUTION: Proceeding with live community node '$N_NAME' (--force-live-node enabled)."
    fi
  fi

  if [ "$N_USER" = "azureuser" ]; then
    SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes -i ~/.ssh/id_azure_lattice"
  else
    SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=30 -o TCPKeepAlive=yes"
  fi

  # Stream updates over SSH via stdin to remote updater
  UPDATE_SCRIPT=$(cat << 'REMOTE_PYTHON'
import sys, os, subprocess

dry_run = (sys.argv[1] == "1")
project_dir = sys.argv[2]
proj_name = sys.argv[3]
env_path = os.path.join(project_dir, ".env")

updates = {}
order = []
for line in sys.stdin:
    line = line.rstrip("\r\n")
    if not line or line.startswith("#"):
        continue
    if "=" in line:
        k, v = line.split("=", 1)
        k = k.strip()
        updates[k] = v
        if k not in order:
            order.append(k)

if not os.path.isdir(project_dir):
    print(f"🛑 Error: Project directory {project_dir} does not exist", file=sys.stderr)
    sys.exit(2)

existing_lines = []
if os.path.exists(env_path):
    with open(env_path, "r") as f:
        existing_lines = f.readlines()
else:
    print(f"ℹ️ Note: .env file does not exist at {env_path}, will create")

new_lines = []
seen = set()

for line in existing_lines:
    stripped = line.rstrip("\r\n")
    if stripped and not stripped.startswith("#") and "=" in stripped:
        k, _ = stripped.split("=", 1)
        k = k.strip()
        if k in updates:
            new_lines.append(f"{k}={updates[k]}\n")
            seen.add(k)
            action = "would update" if dry_run else "updated"
            print(f"  [{action}] {k} (len={len(updates[k])})")
            continue
    new_lines.append(line)

for k in order:
    if k not in seen:
        new_lines.append(f"{k}={updates[k]}\n")
        seen.add(k)
        action = "would add" if dry_run else "added"
        print(f"  [{action}] {k} (len={len(updates[k])})")

if dry_run:
    print(f"  [dry-run] Would write updated .env to {env_path} (mode 0600)")
    print(f"  [dry-run] Would run: cd {project_dir} && docker compose -p {proj_name} up -d --no-deps --force-recreate beanpool-node")
    sys.exit(0)

# Real update: create backup, write atomically, chmod 0600
if os.path.exists(env_path):
    import time
    bak_path = f"{env_path}.bak.{int(time.time())}"
    with open(bak_path, "w") as f:
        f.writelines(existing_lines)
    os.chmod(bak_path, 0o600)
    print(f"  [backup] Created backup at {bak_path}")

tmp_path = f"{env_path}.tmp.{os.getpid()}"
with open(tmp_path, "w") as f:
    f.writelines(new_lines)
os.chmod(tmp_path, 0o600)
os.replace(tmp_path, env_path)
print(f"  [success] Saved updated .env (permissions 0600)")

# Restart only beanpool-node container
print(f"  [restart] Recreating beanpool-node container (cloudflared untouched)...")
cmd = ["docker", "compose", "-p", proj_name, "up", "-d", "--no-deps", "--force-recreate", "beanpool-node"]
res = subprocess.run(cmd, cwd=project_dir, capture_output=True, text=True)
if res.returncode != 0:
    print(f"🛑 Docker compose failed:\n{res.stderr}", file=sys.stderr)
    sys.exit(res.returncode)

print(f"  [restarted] beanpool-node container recreated successfully")
REMOTE_PYTHON
)

  # Pass KEY=VALUE pairs over SSH standard input
  set +e
  printf '%s\n' "${KEY_VALUE_PAIRS[@]}" | ssh $SSH_OPTS "$N_USER@$N_HOST" "python3 -c '$UPDATE_SCRIPT' '$DRY_RUN' '$PROJECT_DIR' '$PROJ_NAME'"
  RC=$?
  set -e

  if [ $RC -eq 0 ]; then
    echo "✅ $N_NAME completed successfully."
  else
    echo "❌ $N_NAME failed with exit code $RC"
    FAILED_NODES+=("$N_NAME (code $RC)")
  fi
  echo ""
done

echo "=========================================================="
if [ ${#FAILED_NODES[@]} -eq 0 ]; then
  echo "🎉 All targeted nodes processed successfully!"
  exit 0
else
  echo "❌ Rotation finished with errors on: ${FAILED_NODES[*]}"
  exit 1
fi
