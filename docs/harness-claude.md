# Claude Code adapter

Adapter id: `claude-code`; binary: `claude`.

## Modes and launch

Claude supports session and global mode. Session launch does not relocate
`CLAUDE_CONFIG_DIR`; it preserves Claude's real authentication/state and adds the
generated view explicitly:

```text
--add-dir=<view>
--mcp-config=<view>/.mcp.json
CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1
```

A failed view build or probe launches the real binary without these overrides
and emits one warning.

## Surfaces

| Canonical content | Session destination | Global destination | Mechanism |
|---|---|---|---|
| `skills/` | `<view>/.claude/skills` | `~/.claude/skills` | item projection |
| `agents/` | `<view>/.claude/agents` | `~/.claude/agents` | item projection |
| `commands/` | `<view>/.claude/commands` | `~/.claude/commands` | item projection |
| `instructions/*.md` | managed blocks in `<view>/CLAUDE.md` | `~/.claude/rules` | inline blocks / item projection |
| `mcp/servers.yaml` | `<view>/.mcp.json` | `~/.claude.json` | keyed JSON projection |

Global MCP belongs in the top-level `~/.claude.json`, not
`~/.claude/.claude.json`. Canonical MCP definitions retain transport and
`${VAR}` placeholder provenance. Lossless harness-side field changes can reverse
project; ambiguous or concurrent changes are quarantined.

The real-child probe runs `claude mcp list` with the rendered session launch and
checks the expected server name when one exists, otherwise it falls back to a
version/mechanism check. Live checks are opt-in with `AGENTENV_LIVE=1`.
