# OpenCode adapter

Adapter id and binary: `opencode`.

## Modes and launch

OpenCode supports session and global mode. `OPENCODE_CONFIG_DIR` alone is an
additive layer, not isolation. Session launch therefore sets both:

```text
OPENCODE_CONFIG_DIR=<view>
XDG_CONFIG_HOME=<parent-of-view>
```

The view directory is named `opencode`, making `$XDG_CONFIG_HOME/opencode` the
same generated root. Provider credentials live under XDG data, not this config
root, so session isolation does not relocate authentication.

## Surfaces

| Canonical content | Destination below the mode root | Mechanism |
|---|---|---|
| `skills/` | `skills/` | item projection |
| `agents/` | `agents/` | item projection |
| `commands/` | `commands/` | item projection |
| `instructions/*.md` | `opencode.json` → `instructions[]` | array-element JSON projection |
| `mcp/servers.yaml` | `opencode.json` → `mcp` | keyed JSON projection |

Global shared skills also compile once to `~/.agents/skills`. MCP local servers
use OpenCode's command array and `environment`; remote servers use its native
headers and `{env:VAR}` placeholder form. Reverse projection preserves the prior
canonical transport/command split and quarantines irreducible ambiguity.

The probe runs `opencode mcp list` under both overrides and checks an expected
server name when present. Live checks are opt-in with `AGENTENV_LIVE=1`.
