# Claude Code Hooks Pack (optional)

SysQlow's memory works in any MCP client through agent-followed instructions
([SKILL.md](../SKILL.md) → *Session Memory Protocol*). Claude Code additionally
supports [hooks](https://docs.claude.com/en/docs/claude-code/hooks), which make
the session-start injection **fully automatic** — the briefing lands in context
before the agent even decides anything.

This pack targets the **shared SSE server** setup (one sysqlow instance, every
client points at it):

```bash
MCP_TRANSPORT=sse PORT=50741 bun start
```

## SessionStart hook — auto-inject the briefing

Add to `~/.claude/settings.json` (all projects) or `<project>/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/sysqlow-context.sh"
          }
        ]
      }
    ]
  }
}
```

And create `~/.claude/hooks/sysqlow-context.sh` (make it executable):

```bash
#!/usr/bin/env bash
# Injects the SysQlow session briefing as additional context at session start.
# Fails silent: if the sysqlow server is down, the session starts normally.
set -euo pipefail

SYSQLOW_URL="${SYSQLOW_URL:-http://localhost:50741}"
WORKSPACE="${CLAUDE_PROJECT_DIR:-$PWD}"

BRIEFING=$(curl -sf --max-time 3 \
  --get "$SYSQLOW_URL/api/context" \
  --data-urlencode "path=$WORKSPACE" \
  --data-urlencode "format=markdown" || true)

if [ -n "$BRIEFING" ]; then
  # Emit hook JSON: additionalContext is injected into the agent's context.
  jq -n --arg ctx "$BRIEFING" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
fi
```

With this in place, every Claude Code session starts with the project's memory
already loaded — including session summaries left by other agents (Cursor,
Claude Desktop) — and the capture protocol that tells the agent to write
memory back.

## Verification

```bash
curl -s "http://localhost:50741/api/context?path=$PWD" | head -30
```

You should see the `# SysQlow Session Briefing` markdown. If the project is
unknown, the first MCP client connect (or a `learn_codebase` /
`collect_codebase_files` call) registers it.

## Notes

- **Claude Desktop on Windows + server in WSL:** Windows reaches WSL2 services
  on `localhost`, so `http://localhost:50741/sse` works as the MCP endpoint
  from the Windows side. Pass `projectName` in tool calls when the Windows
  path isn't visible to the WSL server.
- **Why HTTP and not an MCP call in the hook?** Hooks are plain shell commands;
  one `curl` against `/api/context` is cheaper and simpler than spawning an
  MCP handshake. The endpoint mirrors the `get_session_context` tool exactly.
- **End-of-session summaries** stay agent-driven (the protocol in the briefing
  instructs the agent to `record_observation { kind: "session_summary" }`).
  A `Stop`-hook automation would need an LLM to write the summary — the agent
  already is one.
