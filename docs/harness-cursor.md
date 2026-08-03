# Cursor adapter

Adapter id: `cursor`; binary: `agent` (the current official Cursor CLI command).
The previous `cursor-agent` command remains a compatibility alias and receives
the same fail-open/global-only shim behavior.

## Modes

Cursor is global-only. `CURSOR_CONFIG_DIR` does not isolate the CLI's MCP
resolution reliably, and GUI launches do not inherit a shell override. A shim
launch therefore fails open to the untouched real binary and reports that
`--global` is required.

## Surfaces

| Canonical content | Global destination | Mechanism |
|---|---|---|
| `skills/` | `~/.agents/skills` | shared item projection |
| `mcp/servers.yaml` | `~/.cursor/mcp.json` | keyed JSON projection |
| global instructions | unsupported | reported skip |

Cursor User Rules live in application/cloud settings rather than a clean file
surface, so agentenv does not pretend to manage them. Project `.cursor/rules`
and `AGENTS.md` remain user/project inputs and are never composed as global
rules.

The global MCP path uses whole-file semantic validation. A malformed existing
or rendered entry is rejected and the agentenv write is rolled back. Team or
enterprise policy may still override user configuration; status reports this as
a limitation rather than claiming control.
