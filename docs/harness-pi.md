# Pi adapter

Adapter id and binary: `pi`.

## Modes and launch

Pi supports session and global mode. Session launch points
`PI_CODING_AGENT_DIR` at the generated root. Authentication and trust files are
classified pass-through state; agentenv does not modify their contents.

## Surfaces

| Canonical content | Destination below `~/.pi/agent` or the session root | Mechanism |
|---|---|---|
| `skills/` | `skills/` | item projection |
| `instructions/*.md` | `AGENTS.md` | managed blocks |
| `commands/` | `prompts/` | item projection |
| Pi resource references | `settings.json` arrays | array-element JSON projection |
| `mcp/servers.yaml` | unsupported | reported skip |

Pi has no native MCP support. This declaration is intentionally visible in
`status` and during activation; it must not abort surfaces supported by the
other adapters.

The probe uses `pi list --no-approve` with `PI_OFFLINE=1`; it never uses the
interactive, mutating `pi config` command. Live checks are opt-in with
`AGENTENV_LIVE=1`.
