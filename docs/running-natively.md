# Running sysqlow-mcp Natively (No Docker)

The `./run-docker.sh` path is the supported default, but Docker bind-mounts
have a structural limitation: they're declared at container start and
immutable afterward. That means a project under a path you didn't declare
at boot is invisible to the container, even if the path is correct on the
host. `learn_codebase` will report "no configuration files found" for a
directory you can clearly `ls` outside the container.

The auto-probe in `run-docker.sh` covers the common cases (`~/Projects`,
`~/work`, `~/code`, etc.), but if your projects live somewhere unusual,
running natively sidesteps the mount question entirely — the server reads
files directly from the host filesystem at request time.

## When to choose native over Docker

| Use Docker | Use native |
|---|---|
| Production / remote (Render, Fly) | Local development on macOS / Linux |
| You want filesystem isolation | You want unrestricted workspace access |
| You're OK restarting the container when adding roots | You jump between many unrelated project trees |
| You manage credentials via container env vars | You're comfortable putting keys in your shell env |

## Setup

### 1. Install Bun

```bash
curl -fsSL https://bun.sh/install | bash
```

Or via Homebrew:

```bash
brew install oven-sh/bun/bun
```

### 2. Install dependencies

From the sysqlow-mcp checkout:

```bash
bun install
```

### 3. Configure environment

Export the same variables you'd otherwise put in `.env`. The minimum:

```bash
export GEMINI_API_KEY="your-key"
# Optional Turso (omit for local-only SQLite at ./sysqlow.db):
export TURSO_DATABASE_URL="libsql://..."
export TURSO_AUTH_TOKEN="..."
# Optional fallbacks:
export OPENROUTER_API_KEY="..."
export TAVILY_API_KEY="..."
```

Tip: put these in a `.envrc` (direnv) or a shell-sourced file so you
don't have to re-export every session.

### 4. Run

For Claude Desktop / Cursor / any stdio MCP client:

```bash
bun start
```

For HTTP+SSE mode (dashboard + remote clients):

```bash
MCP_TRANSPORT=sse PORT=50741 bun start
# Dashboard: http://localhost:50741/
# SSE:       http://localhost:50741/sse
```

Watch mode for development:

```bash
bun dev
```

## MCP client config

Stdio:

```json
{
  "mcpServers": {
    "sysqlow": {
      "command": "bun",
      "args": ["start"],
      "cwd": "/Users/barayuda/Projects/personal/sysqlow-mcp",
      "env": {
        "GEMINI_API_KEY": "...",
        "TURSO_DATABASE_URL": "...",
        "TURSO_AUTH_TOKEN": "..."
      }
    }
  }
}
```

SSE:

```json
{
  "mcpServers": {
    "sysqlow": {
      "url": "http://localhost:50741/sse"
    }
  }
}
```

## What changes vs. Docker

- **Filesystem:** unrestricted. `learn_codebase` can read any path the
  user running `bun start` can read. No mount-scope errors.
- **DB:** local file at `./sysqlow.db` (or `LOCAL_DB_PATH`) unless
  Turso is configured. Same schema, same migrations.
- **Credentials:** live in your shell env, not container env. Standard
  shell hygiene applies (don't `echo $GEMINI_API_KEY` into logs).
- **Process model:** sysqlow-mcp runs as your user, sharing your `node`/
  `bun` install, not the pinned image versions. Dependency drift is
  possible if you upgrade Bun system-wide.
- **No container restarts:** scanning a new project root is immediate;
  no `SYSQLOW_WORKSPACE_ROOTS` to manage, no `./run-docker.sh` rerun.

## Switching back to Docker

Run `./run-docker.sh` again. The local SQLite file (`./sysqlow.db`)
will be ignored — Docker uses its own data directory at `./data/`. If
you want to keep the knowledge bank you built up natively, copy the
file in:

```bash
cp ./sysqlow.db ./data/sysqlow.db
./run-docker.sh
```

Or sync to Turso once natively, then point the Docker container at the
same Turso URL — the data follows the cloud, not the binary.
