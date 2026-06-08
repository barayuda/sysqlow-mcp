# Deploying sysqlow-mcp to Render.com

This guide covers deploying sysqlow-mcp to Render's free tier as a remote MCP
server reachable over SSE. The same instructions apply with minor tweaks to
any host with ephemeral disk (Fly.io machines without volumes, Railway free,
Heroku-style platforms).

## Why remote-only mode

Render free has two constraints that break libSQL's default embedded-replica
mode:

1. **Ephemeral filesystem.** Anything written under `/app/` survives until the
   container restarts, then it's gone. A libSQL embedded replica caches the
   entire Turso database in a local `.db` file — on Render free, that cache
   is rebuilt from scratch on every cold start, wasting Turso row reads and
   adding seconds to boot.
2. **Scale-to-zero.** After 15 minutes of inactivity Render suspends the
   container. The next request triggers a cold start. With embedded-replica,
   that cold start includes a full `client.sync()` against Turso before any
   query can run.

`SYSQLOW_DB_REMOTE_ONLY=1` short-circuits both problems: the libSQL client
opens a direct connection to Turso, no local file is created, no sync runs,
and the container's writable layer stays empty. The tradeoff is that every
query is a network round-trip (typically 50–200 ms depending on Turso region)
instead of a microsecond local read.

## Prerequisites

- A [Turso](https://turso.tech/) account with a database created. Free tier
  is plenty for normal personal use.
- A [Render](https://render.com/) account.
- A [Google AI Studio](https://aistudio.google.com/apikey) API key for Gemini
  (Sentinel validation + embeddings).
- *(Recommended)* A [Tavily](https://tavily.com) API key (free tier: 1,000
  searches/month, no card). If omitted, Sentinel falls back to scraping
  DuckDuckGo HTML — note that DDG frequently returns `ConnectionRefused`
  from Render's egress IPs, effectively leaving Sentinel without web evidence.

## Deploy via Blueprint (recommended)

The repo ships a `render.yaml` Blueprint that pre-wires every Render setting
except secrets:

1. Fork this repo to your own GitHub account.
2. In Render, click **New → Blueprint** and point it at your fork.
3. Render reads `render.yaml` and shows you the env vars to fill in:
   - `TURSO_DATABASE_URL` — your `libsql://...` URL from Turso dashboard
   - `TURSO_AUTH_TOKEN` — token from `turso db tokens create <db>`
   - `GEMINI_API_KEY` — your AI Studio key
   - `TAVILY_API_KEY` — *(recommended)* your Tavily key, or leave blank to let Sentinel fall back to DDG (often blocked from Render IPs)
4. Click **Apply**. Render builds the Docker image, sets
   `SYSQLOW_DB_REMOTE_ONLY=1` + `MCP_TRANSPORT=sse` automatically, and starts
   the service.

First boot takes 2–4 minutes (Docker build + Bun install). Subsequent deploys
reuse the cached layers and take ~30 seconds.

Once it's up, your MCP server is reachable at:
- **Dashboard:** `https://<your-service>.onrender.com/`
- **SSE endpoint:** `https://<your-service>.onrender.com/sse`

## Deploy manually

If you don't want to use the Blueprint:

1. **New → Web Service** in Render, point at your fork.
2. Choose **Docker** runtime, **Free** plan.
3. Set env vars in the dashboard:

   | Key | Value |
   |---|---|
   | `SYSQLOW_DB_REMOTE_ONLY` | `1` |
   | `MCP_TRANSPORT` | `sse` |
   | `TURSO_DATABASE_URL` | `libsql://...` |
   | `TURSO_AUTH_TOKEN` | *(your token)* |
   | `GEMINI_API_KEY` | *(your key)* |
   | `TAVILY_API_KEY` | *(recommended)* |

   **Do not set `PORT`.** Render injects its own value and routes external
   traffic to whatever port the service binds. The app reads
   `process.env.PORT` and falls back to `50741` when unset, so it works
   either way — but declaring `PORT` here can shadow Render's value and
   break routing.

4. **Health check path:** `/` (the static dashboard — avoid `/api/budget` or
   `/api/graph` because they hit Turso on every poll and burn quota).
5. Deploy.

## Connecting an MCP client

Point your MCP client at the SSE endpoint. For Cursor's `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sysqlow": {
      "url": "https://<your-service>.onrender.com/sse"
    }
  }
}
```

Claude Desktop and other clients use the same URL with their own config shape.

## Tradeoffs and gotchas

- **Cold starts (~10–20 s).** Render free suspends after 15 min idle. The
  first request after suspension waits for the container to spin up — boot
  is fast (no replica sync), but the Docker layer warm-up still takes time.
  For interactive use, the first tool call after a quiet period feels slow;
  subsequent calls are normal latency.
- **Every read is a Turso round-trip.** The `/api/graph` dashboard endpoint
  and `recall_knowledge` FTS queries used to run locally; now they hit
  Turso. For a single operator this is fine. Don't expect to serve dozens of
  concurrent clients on free tier.
- **Sentinel cron stays active.** The 12 h Sentinel audit and the 30 s
  startup coherence sweep both run normally — they just talk to Turso
  directly. The LLM budget guard caps daily Gemini spend regardless.
- **No offline mode.** Lose network to Turso and the server can't serve any
  request. Embedded-replica mode would have kept reads working from the
  local cache; remote-only mode does not.
- **Free tier limits.** Render free gives you 750 hours/month, which is
  enough for one always-on service. If your service hits the cap or you
  need persistent disk, upgrade to Render's Starter plan and switch to
  embedded-replica mode (`SYSQLOW_DB_REMOTE_ONLY` unset, add a 1 GB disk
  mounted at `/app/db`).

## Optional: SearXNG sidecar for keyless search resilience

If you'd rather not depend on a Tavily key (or want extra durability beyond
their 1,000-search/month tier), you can run [SearXNG](https://searxng.github.io)
as a sidecar service on Render itself.

1. Create a second Render service from the public image `searxng/searxng:latest`.
2. Set its internal hostname (e.g. `sysqlow-searxng`); leave the port at the
   default `8080`.
3. In your sysqlow-mcp service env vars, set:
   `SEARXNG_URL=http://sysqlow-searxng:8080`
4. (Recommended) Configure SearXNG's `settings.yml` to disable web UI access
   and restrict JSON output to internal traffic only.

The chain order is Tavily → SearXNG → DDG, so SearXNG only fires when Tavily
isn't keyed or errors. Combined with `SYSQLOW_DDG_FALLBACK=false`, this gives
you a fully-self-hosted search tier with no third-party quotas.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Container exits immediately with `requires TURSO_DATABASE_URL` | Flag is on but URL is unset/blank | Set `TURSO_DATABASE_URL` in Render env vars |
| Container exits with `libsql:// or https://` | Flag is on but URL is `file:...` or some other scheme | Set `TURSO_DATABASE_URL` to your full `libsql://...` URL |
| Container exits with `requires TURSO_AUTH_TOKEN` | Flag is on but token is unset | Run `turso db tokens create <db>` and paste the result |
| MCP client connects but every tool errors with quota messages | Daily Gemini quota exhausted | Wait for midnight Pacific or call `set_llm_budget` to raise caps |
| Dashboard loads but `/api/graph` returns 500 | Turso connection issue | Check the Render logs for `[DB Mode Guard]`; verify the URL/token are correct |
| Cold-start requests time out in MCP client | Render took >30 s to wake up; client timed out first | Retry the request once the dashboard responds, or upgrade off free tier |

## Switching back to embedded-replica

If you later add a Render disk (Starter plan, $7/mo + $0.25/GB):

1. Add a disk in Render, mount path `/app/db`, size 1 GB.
2. Unset `SYSQLOW_DB_REMOTE_ONLY` in env vars.
3. The next deploy will create `/app/db/sysqlow.db` and start using
   embedded-replica mode. The first boot does a full sync from Turso to
   populate the cache; subsequent reads are local.

No data migration needed — the local file is just a cache of what's already
in Turso.
