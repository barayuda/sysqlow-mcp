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

# Dynamically mount parent directories to allow scanning multi-workspaces inside Docker.
# If the project is within the user's HOME directory, we mount the entire HOME folder
# to ensure absolute path parity for all projects. Otherwise, we mount the parent of the project.
VOLUME_MOUNT="-v $PROJECT_DIR:$PROJECT_DIR"
if [[ "$PROJECT_DIR" == "$HOME"* ]]; then
  echo "🏠 Project detected within HOME. Mirroring HOME directory for cross-workspace compatibility..." >&2
  VOLUME_MOUNT="-v $HOME:$HOME"
else
  PARENT_DIR="$(dirname "$PROJECT_DIR")"
  echo "📁 Project detected outside HOME. Mirroring parent directory: $PARENT_DIR..." >&2
  VOLUME_MOUNT="-v $PARENT_DIR:$PARENT_DIR"
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
  sysqlow-mcp
