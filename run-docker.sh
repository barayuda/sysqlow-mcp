#!/bin/bash

# ==============================================================================
# SysQlow-MCP Docker Build & Run Automation Script (Best Practice Persistent Setup)
# ==============================================================================

# Exit immediately if any command fails
set -e

# ---------------------------------------------------------
# Dynamic Paths Resolution for Cross-Machine Compatibility
# ---------------------------------------------------------
# Resolve project directory dynamically (works on any machine)
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$PROJECT_DIR/data"
ENV_FILE="$PROJECT_DIR/.env"
CONTAINER_NAME="sysqlow-mcp"

# ---------------------------------------------------------
# Secure-by-default mount scope
# ---------------------------------------------------------
# Previous versions of this script mounted the entire $HOME directory into
# the container whenever the project lived under $HOME. That gave the
# container read/write access to ~/.ssh, ~/.aws/credentials, ~/.npmrc, etc.
# — a large blast radius if any dependency inside the container were
# ever compromised.
#
# New behavior: mount only the paths the server actually needs to do its
# job — by default the sysqlow-mcp checkout itself and the host workspace
# the MCP client was launched from (captured in HOST_WORKSPACE_DIR below
# before we cd into PROJECT_DIR). Users who jump between multiple
# workspaces in one session can opt in to additional roots via the
# SYSQLOW_WORKSPACE_ROOTS env var (comma-separated absolute paths; `~`
# is expanded to $HOME). Nested paths are collapsed to the shortest
# covering ancestor so Docker doesn't error on overlapping mounts.
#
# See README.md "Security Checklist & Data Leak Prevention Audit" and
# .env.example section 6 for the user-facing documentation.

# Capture the host's invocation cwd BEFORE we `cd` into the project
# directory, so the coherence engine inside the container can detect
# which workspace the MCP client was launched from. (Previously this
# only fed SYSQLOW_WORKSPACE_DIR; now it also drives mount scope.)
HOST_WORKSPACE_DIR="$PWD"

declare -a MOUNT_CANDIDATES
MOUNT_CANDIDATES+=("$PROJECT_DIR")

if [ -n "$HOST_WORKSPACE_DIR" ] \
   && [ -d "$HOST_WORKSPACE_DIR" ] \
   && [ "$HOST_WORKSPACE_DIR" != "/" ]; then
  MOUNT_CANDIDATES+=("$HOST_WORKSPACE_DIR")
fi

if [ -n "${SYSQLOW_WORKSPACE_ROOTS:-}" ]; then
  while IFS= read -r raw_root; do
    # Trim whitespace; expand leading ~ to $HOME.
    root="${raw_root#"${raw_root%%[![:space:]]*}"}"
    root="${root%"${root##*[![:space:]]}"}"
    root="${root/#\~/$HOME}"
    [ -z "$root" ] && continue
    if [ -d "$root" ]; then
      MOUNT_CANDIDATES+=("$root")
    else
      echo "⚠️  SYSQLOW_WORKSPACE_ROOTS entry '$root' is not a directory; skipping." >&2
    fi
  done < <(echo "$SYSQLOW_WORKSPACE_ROOTS" | tr ',' '\n')
fi

# Collapse nested paths: process shortest-first, drop any candidate that
# already nests under an accepted mount. (Docker errors on overlapping
# bind mounts on some platforms; this also keeps the -v flag list minimal.)
declare -a MOUNT_PATHS
while IFS= read -r cand; do
  [ -z "$cand" ] && continue
  is_nested=0
  for kept in "${MOUNT_PATHS[@]:-}"; do
    [ -z "$kept" ] && continue
    case "$cand" in
      "$kept"|"$kept"/*) is_nested=1; break ;;
    esac
  done
  if [ "$is_nested" -eq 0 ]; then
    MOUNT_PATHS+=("$cand")
  fi
done < <(printf '%s\n' "${MOUNT_CANDIDATES[@]}" | awk '{ print length, $0 }' | sort -n | cut -d' ' -f2-)

VOLUME_MOUNT=""
echo "🔒 Mounting host paths into container (secure-by-default):" >&2
for path in "${MOUNT_PATHS[@]}"; do
  echo "   • $path" >&2
  VOLUME_MOUNT="$VOLUME_MOUNT -v $path:$path"
done
if [ -z "${SYSQLOW_WORKSPACE_ROOTS:-}" ]; then
  echo "   (set SYSQLOW_WORKSPACE_ROOTS=~/path1,~/path2 to expose extra workspace roots)" >&2
fi

# Default configuration parameters
TRANSPORT_MODE="stdio"
DETACHED_FLAG="-i --rm"
PORT_MAPPING=""
MCP_TRANSPORT="stdio"
PORT="50741"

# Check for transport mode arguments (--sse or -s)
if [ "$1" == "--sse" ] || [ "$1" == "-s" ]; then
  TRANSPORT_MODE="sse"
  DETACHED_FLAG="-d --rm"
  PORT_MAPPING="-p 50741:50741"
  MCP_TRANSPORT="sse"
fi

# HOST_WORKSPACE_DIR was captured earlier (before mount-scope resolution
# needed it). Keep that capture as the single source of truth and just
# `cd` into the project here.
cd "$PROJECT_DIR"

# Save stdout to FD 3, and redirect stdout to stderr for the setup and build phases.
# This prevents diagnostic logs and build logs from polluting stdout, which
# would corrupt the MCP JSON-RPC protocol when the client spawns this script directly.
exec 3>&1
exec 1>&2

echo "=========================================================="
echo "🛡️  SysQlow-MCP: Initializing Persistent Environment..."
echo "=========================================================="

if [ "$TRANSPORT_MODE" == "sse" ]; then
  echo "🌐 Target Transport: Server-Sent Events (SSE/HTTP) Detached"
  echo "🔌 Exposed Port: $PORT"
else
  echo "🔌 Target Transport: Standard I/O (Stdio) Attached"
fi

# 1. Create a dedicated database directory to keep the root repository clean
if [ ! -d "$DATA_DIR" ]; then
  echo "📁 Creating database directory: $DATA_DIR"
  mkdir -p "$DATA_DIR"
fi

# 2. Migration: Safely move any legacy database files from root to the data folder
migrate_db_file() {
  local filename=$1
  if [ -f "$PROJECT_DIR/$filename" ]; then
    echo "📦 Migrating $filename to data/ directory..."
    mv "$PROJECT_DIR/$filename" "$DATA_DIR/$filename"
  fi
}

migrate_db_file "sysqlow.db"
migrate_db_file "sysqlow.db-info"
migrate_db_file "sysqlow.db-shm"
migrate_db_file "sysqlow.db-wal"

# 3. Load variables from local .env file
if [ -f "$ENV_FILE" ]; then
  echo "🔑 Loading environment variables from .env file..."
  export $(grep -v '^#' "$ENV_FILE" | xargs)
else
  echo "⚠️  WARNING: No .env file found at $ENV_FILE!"
  echo "Make sure TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, and GEMINI_API_KEY are configured."
fi

# 4. Clean up any existing containers with the same name to prevent naming conflicts
echo -e "\n🧹 Checking for existing container named '$CONTAINER_NAME'..."
if [ "$(docker ps -aq -f name=^/${CONTAINER_NAME}$)" ]; then
  echo "⏹️  Stopping and removing old container '$CONTAINER_NAME'..."
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

# 5. Build the local Docker image
echo -e "\n=========================================================="
echo "🛠️  Building SysQlow-MCP Docker Image..."
echo "=========================================================="
docker build -t sysqlow-mcp .

# 6. Clean up old untagged/dangling images from previous builds to save disk space
echo -e "\n🧹 Pruning previous untagged/dangling builds to optimize Mac storage..."
docker image prune -f --filter "dangling=true" >/dev/null 2>&1 || true

# 7. Run the container securely with the selected flags
echo -e "\n=========================================================="
echo "🚀 Running SysQlow-MCP in Containerized Mode..."
echo "📊 Persistent Volume: $DATA_DIR"
echo "📛 Container Name: $CONTAINER_NAME"
if [ "$TRANSPORT_MODE" == "sse" ]; then
  echo "🌐 SSE URL Endpoint: http://localhost:50741/sse"
  echo "🖥️  Web Admin Dashboard: http://localhost:50741/"
fi
echo "=========================================================="

# Restore stdout for the actual container process
exec 1>&3
exec 3>&-

# Run container with dynamically configured parameters:
#  --name : names the container explicitly
#  $DETACHED_FLAG : -i (attached stdio) or -d (detached SSE)
#  $PORT_MAPPING : maps port 32768 only when in SSE mode
#  -v : mounts database directory
#  -e : injects environment credentials
docker run $DETACHED_FLAG \
  --name "$CONTAINER_NAME" \
  $PORT_MAPPING \
  -v "$DATA_DIR:/app/db" \
  $VOLUME_MOUNT \
  -e TURSO_DATABASE_URL="$TURSO_DATABASE_URL" \
  -e TURSO_AUTH_TOKEN="$TURSO_AUTH_TOKEN" \
  -e GEMINI_API_KEY="$GEMINI_API_KEY" \
  -e BRAVE_API_KEY="$BRAVE_API_KEY" \
  -e MCP_TRANSPORT="$MCP_TRANSPORT" \
  -e PORT="$PORT" \
  -e SYSQLOW_WORKSPACE_DIR="$HOST_WORKSPACE_DIR" \
  sysqlow-mcp
