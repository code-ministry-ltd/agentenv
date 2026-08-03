# Codex adapter

Adapter id and binary: `codex`.

## Modes and launch

Codex supports session and global mode. Session launch points `CODEX_HOME` at an
immutable generated view. Authentication and stable user state are inherited
through classified pass-through entries; agentenv never grants project trust.

## Surfaces

| Canonical content | Session destination | Global destination | Mechanism |
|---|---|---|---|
| `skills/` | `<view>/skills` | `~/.agents/skills` | item projection |
| `commands/` | `<view>/skills` | `~/.agents/skills` | command-as-skill projection |
| `instructions/*.md` | `<view>/AGENTS.md` | `~/.codex/AGENTS.md` | managed blocks |
| `mcp/servers.yaml` | `<view>/config.toml` | `~/.codex/config.toml` | keyed TOML projection |
| `files/codex/agents/**` | `<view>/agents/**` | `~/.codex/agents/**` | traversal-safe raw mapping |

The ordinary canonical `agents/` Markdown surface is unsupported for Codex;
Codex subagents use raw TOML files under `files/codex/agents/`. Transport shape,
native indirections, unknown TOML fields, and `${VAR}` provenance are preserved
where an inverse is lossless. Codex MCP secret placeholders are resolved only
for the child/materialiser and never written back as literals.

The real-child probe runs Codex under the generated `CODEX_HOME` and validates
the expected MCP entry when present. Live checks are opt-in with
`AGENTENV_LIVE=1`.
