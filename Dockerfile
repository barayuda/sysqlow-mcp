# Use the official, lightweight Alpine-based Bun image (only ~40MB)
FROM oven/bun:alpine AS base
WORKDIR /app

# Copy package files and schema
COPY package.json bun.lock tsconfig.json schema.sql ./

# Install production dependencies
RUN bun install --production --no-scripts

# Copy the source code
COPY src ./src

# Bundle the code into the dist directory for peak startup speed inside the container
RUN bun run build

# Default the local SQLite path to /app/db/sysqlow.db so local-Docker users
# (via run-docker.sh, which mounts a host directory at /app/db) get
# persistent storage out of the box.
#
# Note: we deliberately do NOT set TURSO_DATABASE_URL here. Setting a
# file: default would silently shadow remote-only / embedded-replica
# deployments where the operator forgot to wire TURSO_DATABASE_URL — the
# container would fall back to ephemeral SQLite at /app/db/sysqlow.db and
# lose all knowledge on every restart (the worst failure mode for a
# knowledge tool). Operators must pass TURSO_DATABASE_URL explicitly at
# runtime (via -e, .env, or platform env vars). See docs/deploying-to-render.md.
ENV LOCAL_DB_PATH="/app/db/sysqlow.db"

# Expose the port used by the Server-Sent Events (SSE) HTTP transport
EXPOSE 50741

# The standard I/O transport is used by MCP, which communicates over stdin/stdout
CMD ["bun", "run", "dist/index.js"]
