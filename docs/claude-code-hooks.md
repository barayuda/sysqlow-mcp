# How to Set Up the Claude Code SessionStart Hook for SysQlow

> **For AI agents:** this is a runbook. Follow the steps in order. Every step
> has a **Run** command, a **Verify** command, and the **Expected** result.
> Do not go to the next step until Verify gives the Expected result. If it
> does not, follow **If it fails** for that step, then stop and report.

## Goal

Every time Claude Code starts a session, it loads the SysQlow briefing for the
current project into the agent's context automatically. The briefing contains
the project's knowledge, recent session activity, flagged snippets, and the
memory protocol (how to save knowledge back to SysQlow).

## How it works

```
Claude Code session starts
  → runs ~/.claude/hooks/sysqlow-context.sh            (SessionStart hook)
    → curl GET http://localhost:50741/api/context?path=<project dir>
      → SysQlow returns the briefing as markdown
    → script prints {"hookSpecificOutput": {"additionalContext": "<briefing>"}}
  → Claude Code adds the briefing to the agent's context
```

- The hook uses plain HTTP, not MCP. `GET /api/context` returns the same
  briefing as the `get_session_context` MCP tool.
- The hook sends the project folder (`$CLAUDE_PROJECT_DIR`). This is required:
  a shared SysQlow server does not guess the project from its own folder.
- If SysQlow is not running, the hook prints nothing and the session starts
  normally. It waits at most 3 seconds.

## Rules for agents

1. Run each command block as **one** shell call. Blocks do not depend on
   variables from earlier blocks.
2. Steps marked **Changes user config** edit files in the user's home
   folder. Tell the user what will change before you run them.
3. Never write `~/.claude/settings.json` from scratch. Always back it up
   first, then add to it with the `jq` command given. The file may already
   contain other hooks that must be kept.
4. Every step is safe to run again. Running a step twice does not create
   duplicates.
5. You cannot start a new Claude Code session yourself. For the final check
   (Step 6), ask the user to do it.

## Settings

| Name | Default | Change it when |
|---|---|---|
| Repo folder | `$HOME/Projects/personal/sysqlow-mcp` | The repo is somewhere else. Set `SYSQLOW_REPO` in the commands below. |
| Server URL | `http://localhost:50741` | SysQlow runs on another host or port. Set `SYSQLOW_URL` in the hook script's environment. |

---

## Step 1 — Check prerequisites (read-only)

**Run:**

```bash
REPO="${SYSQLOW_REPO:-$HOME/Projects/personal/sysqlow-mcp}"; for c in bun curl jq; do printf '%-5s %s\n' "$c" "$(command -v "$c" || echo MISSING)"; done; test -f "$REPO/package.json" && echo "repo: OK ($REPO)" || echo "repo: MISSING ($REPO)"; test -d "$REPO/node_modules" && echo "deps: OK" || echo "deps: MISSING"
```

**Expected:** a path for `bun`, `curl` and `jq` (no `MISSING`), `repo: OK`, and `deps: OK`.

**If it fails:**
- `jq MISSING` → install it: `sudo apt-get install -y jq` (Debian/Ubuntu/WSL). Ask the user first, since it needs `sudo`.
- `bun MISSING` → install Bun from https://bun.sh, then open a new shell.
- `repo: MISSING` → ask the user where the repo is, and set `SYSQLOW_REPO` in every later command.
- `deps: MISSING` → run `bun install` in the repo folder.

---

## Step 2 — Start SysQlow as a shared server

The hook needs SysQlow running in SSE mode on port 50741. Run it **natively**
(not in Docker), so the project paths Claude Code sends are the same paths the
server sees.

First check whether it is already running:

```bash
curl -sf --max-time 3 -o /dev/null -w '%{http_code}\n' http://localhost:50741/api/logs || echo "NOT RUNNING"
```

If this prints `200`, the server is running: **skip to Step 3.**

Otherwise choose **one** option. Ask the user which one they want. If you cannot
ask, use Option A.

### Option A — tmux (until reboot)

**Run:**

```bash
REPO="${SYSQLOW_REPO:-$HOME/Projects/personal/sysqlow-mcp}"; tmux has-session -t sysqlow 2>/dev/null && echo "already running" || tmux new-session -d -s sysqlow -c "$REPO" "MCP_TRANSPORT=sse PORT=50741 $(command -v bun) run src/index.ts"
```

Stop it later with `tmux kill-session -t sysqlow`. See its logs with `tmux attach -t sysqlow` (detach again with `Ctrl-b` then `d`).

### Option B — systemd user service (starts automatically) — *Changes user config*

Check that systemd is available:

```bash
systemctl --user is-system-running
```

If this prints `running` or `degraded`, continue. Otherwise use Option A.

**Run** (creates `~/.config/systemd/user/sysqlow.service`, then starts it):

```bash
REPO="${SYSQLOW_REPO:-$HOME/Projects/personal/sysqlow-mcp}"; BUN="$(command -v bun)"; mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/sysqlow.service <<EOF && systemctl --user daemon-reload && systemctl --user enable --now sysqlow.service
[Unit]
Description=SysQlow MCP server (shared SSE mode)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=MCP_TRANSPORT=sse
Environment=PORT=50741
ExecStart=$BUN run src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
```

Bun loads the repo's `.env` file automatically (Turso and Gemini settings),
because `WorkingDirectory` is the repo folder. See logs with
`journalctl --user -u sysqlow -f`.

### Verify (both options)

Startup can take up to 30 seconds when the database syncs with Turso.

```bash
for i in $(seq 1 30); do curl -sf --max-time 2 -o /dev/null http://localhost:50741/api/logs && break; sleep 1; done; curl -sf --max-time 3 -o /dev/null -w '%{http_code}\n' http://localhost:50741/api/logs || echo "NOT RUNNING"
```

**Expected:** `200`

**If it fails:** read the server output (Option A: `tmux attach -t sysqlow`;
Option B: `journalctl --user -u sysqlow -n 50`). Common causes: port 50741 is
already in use (`ss -ltnp | grep 50741`), or the `.env` settings are wrong.

---

## Step 3 — Create the hook script — *Changes user config*

**Run** (creates `~/.claude/hooks/sysqlow-context.sh`; running it again overwrites it with the same content):

```bash
mkdir -p ~/.claude/hooks && cat > ~/.claude/hooks/sysqlow-context.sh <<'EOF' && chmod +x ~/.claude/hooks/sysqlow-context.sh
#!/usr/bin/env bash
# Injects the SysQlow session briefing at Claude Code session start.
# Fails silently: if SysQlow is down, the session starts normally.
set -euo pipefail

SYSQLOW_URL="${SYSQLOW_URL:-http://localhost:50741}"
WORKSPACE="${CLAUDE_PROJECT_DIR:-$PWD}"

BRIEFING=$(curl -sf --max-time 3 --get "$SYSQLOW_URL/api/context" \
  --data-urlencode "path=$WORKSPACE" \
  --data-urlencode "format=markdown" || true)

if [ -n "$BRIEFING" ]; then
  jq -n --arg ctx "$BRIEFING" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
fi
EOF
```

**Verify:**

```bash
test -x ~/.claude/hooks/sysqlow-context.sh && bash -n ~/.claude/hooks/sysqlow-context.sh && echo "SCRIPT OK"
```

**Expected:** `SCRIPT OK`

**If it fails:** run Step 3 again. Check that `~/.claude/hooks` is writable.

---

## Step 4 — Test the hook script by hand

The server from Step 2 must be running.

**Run:**

```bash
REPO="${SYSQLOW_REPO:-$HOME/Projects/personal/sysqlow-mcp}"; CLAUDE_PROJECT_DIR="$REPO" ~/.claude/hooks/sysqlow-context.sh | jq -r '.hookSpecificOutput.additionalContext' | head -5
```

**Expected:** the first lines of the briefing, for example:

```
# SysQlow Session Briefing

**Project:** sysqlow-mcp (`/home/<user>/Projects/personal/sysqlow-mcp`) — stack: node, bun, typescript — id `<uuid>`
**Knowledge in scope:** ...
```

**If it fails:**
- No output at all → the server is not reachable. Repeat the Step 2 Verify.
- `jq: parse error` → you probably passed the output through zsh's `echo`,
  which changes `\n` in the JSON. Pipe the script straight into `jq`, as above.
- `**Project:** none matched hint ...` → the server cannot see that folder.
  This happens when SysQlow runs in Docker. Run it natively (Step 2).

---

## Step 5 — Register the hook in Claude Code — *Changes user config*

Tell the user: "I will add one SessionStart hook to `~/.claude/settings.json`.
Existing hooks are kept, and I will make a backup first."

**Run** (backup, then add the hook only if it is not already there):

```bash
F=~/.claude/settings.json; [ -f "$F" ] || echo '{}' > "$F"; cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)" && jq '.hooks //= {} | .hooks.SessionStart //= [] | if any(.hooks.SessionStart[].hooks[]?; (.command // "") | contains("sysqlow-context.sh")) then . else .hooks.SessionStart += [{"hooks":[{"type":"command","command":"$HOME/.claude/hooks/sysqlow-context.sh"}]}] end' "$F" > "$F.new" && mv "$F.new" "$F" && echo "SETTINGS UPDATED"
```

The `jq` filter adds the hook next to any SessionStart hooks that already exist.
If the SysQlow hook is already registered, it changes nothing.

**Verify:**

```bash
jq -e '[.hooks.SessionStart[]?.hooks[]?.command] | any(contains("sysqlow-context.sh"))' ~/.claude/settings.json && jq -r '[.hooks.SessionStart[]?.hooks[]?.command] | .[]' ~/.claude/settings.json
```

**Expected:** `true`, followed by every SessionStart hook command. This includes
`$HOME/.claude/hooks/sysqlow-context.sh` **and** any hooks that were there before.

**If it fails:** `settings.json` was not changed, because the file is only
replaced after `jq` succeeds. If the file is not valid JSON, restore the newest
backup (see Rollback) and stop.

---

## Step 6 — End-to-end check (needs the user)

Ask the user to:

1. Start a **new** Claude Code session in any project folder.
2. Ask: *"What does SysQlow know about this project?"*

**Expected:** the agent answers from the briefing (project name, knowledge
count) without calling any tool first.

---

## Rollback

Each line below undoes one part. Run only the parts you need.

Remove the hook from `settings.json` (other hooks are kept):

```bash
F=~/.claude/settings.json; cp "$F" "$F.bak-$(date +%Y%m%d-%H%M%S)" && jq '.hooks.SessionStart |= map(.hooks |= map(select((.command // "") | contains("sysqlow-context.sh") | not))) | .hooks.SessionStart |= map(select(.hooks | length > 0))' "$F" > "$F.new" && mv "$F.new" "$F" && echo "HOOK REMOVED"
```

Or restore the newest backup instead:

```bash
ls -t ~/.claude/settings.json.bak-* | head -1
```

Then copy that file over `~/.claude/settings.json`.

Delete the hook script:

```bash
rm -f ~/.claude/hooks/sysqlow-context.sh
```

Stop the server — Option A:

```bash
tmux kill-session -t sysqlow
```

Stop and remove the server — Option B:

```bash
systemctl --user disable --now sysqlow.service && rm -f ~/.config/systemd/user/sysqlow.service && systemctl --user daemon-reload
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| New sessions show no briefing | Server not running | Step 2 Verify. With Option A, the tmux session ends when WSL or the machine restarts. |
| Briefing says `none matched hint` | Server cannot see the project folder (Docker) | Run SysQlow natively (Step 2). |
| Briefing says `none detected` | Hook ran without a project folder | Check that the hook uses `CLAUDE_PROJECT_DIR` (Step 3 content). |
| Briefing shows 0 snippets for a known project | The project is registered under a different path | Call `get_session_context { projectName }`, or save a snippet from inside the project folder. |
| Session start is slow | Server is slow or unreachable | The hook waits at most 3 seconds. Check the server logs. |

## Reference

`GET /api/context` query parameters:

| Parameter | Meaning |
|---|---|
| `path` | Absolute project folder. The hook sends this. |
| `project_id` | Project UUID (alternative to `path`). |
| `name` | Project name (fallback when the path is not visible to the server). |
| `max_items` | Max project-knowledge items, 1–25 (default 8). |
| `format` | `markdown` (default) or `json`. |

The end-of-session summary is not automated by a hook. Writing a summary needs
an LLM, and the agent already is one: the memory protocol in the briefing tells
the agent to call `record_observation { kind: "session_summary", ... }` before
a long session ends.
