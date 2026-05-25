# Use the official, lightweight Alpine-based Bun image (only ~40MB)
FROM oven/bun:alpine AS base
WORKDIR /app

# Copy package files and schema
COPY package.json bun.lock tsconfig.json schema.sql ./

# Install production dependencies
RUN bun install --production

# Copy the source code
COPY src ./src

# Bundle the code into the dist directory for peak startup speed inside the container
RUN bun run build

# Make sure the local database file path is mapped to a persistent directory or volume
# We point to /app/db/sysqlow.db so that the entire folder containing metadata can be mounted
ENV LOCAL_DB_PATH="/app/db/sysqlow.db"
ENV TURSO_DATABASE_URL="file:/app/db/sysqlow.db"

# Expose the port used by the Server-Sent Events (SSE) HTTP transport
EXPOSE 32768

# The standard I/O transport is used by MCP, which communicates over stdin/stdout
CMD ["bun", "run", "dist/index.js"]
