import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude.js';
import { run } from '../src/cli.js';
import { resolvePaths } from '../src/paths.js';
import { composeView } from '../src/session/composer.js';
import { clearSession, setBinding } from '../src/session/registry.js';
import { readState } from '../src/state.js';

/**
 * Task 1.11 — the flagship round-trip e2e pair (spec success criterion 1), and
 * CHECKPOINT B for Phase 1. This is the guarantee the whole stack round-trips
 * clean: it exercises the real Claude adapter + composer + engine + the three
 * surface mechanisms against a **lived-in** Claude config, and asserts that
 * **zero bytes differ outside `~/.agentenv/`** — the hash comparison is EXACT, so
 * a single stray byte fails the test.
 *
 * Two variants, per spec criterion 1:
 * - (a) Session — the stronger form: byte-identical at EVERY step (after compose,
 *   after a simulated session with a write-through edit + a discarded user-content
 *   drift, and after the view is dropped). The private view lives under
 *   `~/.agentenv/live/`; nothing leaks to the real home.
 * - (b) Global — the classic form: hash, `use --global`, `drop --global --all`,
 *   byte-identical outside `~/.agentenv/`.
 *
 * Hermetic: a single temp `HOME` holds `.claude/` (the real config root), `.agents/`
 * (a foreign manager's registry) and `.agentenv/` (the store + live views) as
 * siblings; the real `~/.claude` / `~/.agentenv` are never read or written.
 */

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/**
 * A content+structure hash of a directory tree, EXCLUDING the paths in `exclude`
 * (the `~/.agentenv/` store dir). Files hash by content; symlinks hash by their
 * literal target and are never followed; directories are recorded by name. Two
 * trees hash equal iff they are byte-identical in every file and link target —
 * the exact comparison the round-trip guarantee needs.
 */
function hashTree(root: string, exclude: ReadonlySet<string> = new Set()): string {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      if (exclude.has(abs)) continue;
      const rel = relative(root, abs);
      if (entry.isSymbolicLink()) {
        rows.push(`L ${rel} -> ${readlinkSync(abs)}`);
      } else if (entry.isDirectory()) {
        rows.push(`D ${rel}`);
        walk(abs);
      } else {
        rows.push(`F ${rel} ${sha256(readFileSync(abs))}`);
      }
    }
  };
  walk(root);
  return sha256(rows.join('\n'));
}

/** A hermetic HOME with `.claude/`, `.agents/` and `.agentenv/` as siblings. */
interface LivedInHome {
  home: string;
  claudeHome: string;
  claudeJson: string;
  agentsHome: string;
  agentenvHome: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function makeLivedInHome(): LivedInHome {
  const home = mkdtempSync(join(tmpdir(), 'agentenv-round-trip-'));
  const claudeHome = join(home, '.claude');
  const claudeJson = join(home, '.claude.json');
  const agentsHome = join(home, '.agents');
  const agentenvHome = join(home, '.agentenv');
  mkdirSync(agentenvHome, { recursive: true });
  return {
    home,
    claudeHome,
    claudeJson,
    agentsHome,
    agentenvHome,
    // CLAUDE_CONFIG_DIR points the adapter's realConfigRoot at the fixture .claude;
    // AGENTENV_HOME points the store/state/live at the fixture .agentenv.
    env: { AGENTENV_HOME: agentenvHome, CLAUDE_CONFIG_DIR: claudeHome, HOME: home },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

/**
 * Build a lived-in Claude config: user skills in every dir-merge surface, a
 * **foreign-manager symlink** (a skill that is a symlink into a `~/.agents/`-style
 * dir, à la Vercel's `skills` CLI — agentenv must NEVER touch it), a real
 * `CLAUDE.md`, a populated JSONC `.claude.json` (user `context7` MCP server beside
 * onboarding/state keys, with comments + formatting to preserve), a stand-in
 * `.credentials.json` (bucket 1), a `rules/` dir with a pre-existing user rule, and
 * some non-surface bucket-1 state (`projects/`).
 */
function seedLivedInClaude(h: LivedInHome): void {
  const { claudeHome, claudeJson, agentsHome } = h;

  // A foreign manager's registry (~/.agents/skills) + the symlink into it that
  // lives inside Claude's skills dir. agentenv must leave both untouched.
  mkdirSync(join(agentsHome, 'skills', 'vercel-skill'), { recursive: true });
  writeFileSync(
    join(agentsHome, 'skills', 'vercel-skill', 'SKILL.md'),
    '---\nname: vercel-skill\ndescription: installed by npx skills\n---\n# vercel skill\n',
  );

  // User skills: one plain, one that COLLIDES by name with an env skill, and the
  // foreign-manager symlink.
  mkdirSync(join(claudeHome, 'skills', 'my-notes'), { recursive: true });
  writeFileSync(join(claudeHome, 'skills', 'my-notes', 'SKILL.md'), '# my notes skill\n');
  mkdirSync(join(claudeHome, 'skills', 'shared-skill'), { recursive: true });
  writeFileSync(join(claudeHome, 'skills', 'shared-skill', 'SKILL.md'), '# the USER shared skill\n');
  symlinkSync(
    join(agentsHome, 'skills', 'vercel-skill'),
    join(claudeHome, 'skills', 'vendor-linked'),
  );

  // User agents / commands / rules.
  mkdirSync(join(claudeHome, 'agents'), { recursive: true });
  writeFileSync(join(claudeHome, 'agents', 'my-agent.md'), '# my agent\n');
  mkdirSync(join(claudeHome, 'commands'), { recursive: true });
  writeFileSync(join(claudeHome, 'commands', 'my-cmd.md'), '# my command\n');
  mkdirSync(join(claudeHome, 'rules'), { recursive: true });
  writeFileSync(join(claudeHome, 'rules', 'house-style.md'), '# house style rule\n');

  // Real user CLAUDE.md (bucket 1 for Claude — global instructions go via rules/).
  writeFileSync(join(claudeHome, 'CLAUDE.md'), '# My CLAUDE.md\n\nRemember to be concise.\n');

  // A populated, HAND-EDITED .claude.json (JSONC): comments + 2-space formatting +
  // a user MCP server beside onboarding/trust state. config-keys must inject into
  // mcpServers and later remove surgically, preserving every byte of this.
  writeFileSync(
    claudeJson,
    [
      '// Claude Code config — hand edited, keep these comments!',
      '{',
      '  "hasCompletedOnboarding": true,',
      '  "numStartups": 42,',
      '  "installMethod": "npm",',
      '  "mcpServers": {',
      '    // the user\'s own server — agentenv must preserve it verbatim',
      '    "context7": {',
      '      "type": "http",',
      '      "url": "https://mcp.context7.com/mcp"',
      '    }',
      '  },',
      '  "projects": {',
      '    "/home/user/proj": { "hasTrustDialogAccepted": true }',
      '  }',
      '}',
      '',
    ].join('\n'),
  );

  // Bucket-1 credentials (login pass-through) + other non-surface state.
  writeFileSync(join(claudeHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"tok"}}\n');
  mkdirSync(join(claudeHome, 'projects'), { recursive: true });
  writeFileSync(join(claudeHome, 'projects', 'proj-a.json'), '{"lastCwd":"/home/user/proj"}\n');
}

/**
 * A `writing` store env contributing to every Claude surface: two skills (one
 * UNIQUE, one COLLIDING by name with a user skill), an agent, a command, an
 * instructions file (→ rules symlink), and an MCP server.
 */
function seedWritingEnv(envDir: string): void {
  mkdirSync(join(envDir, 'skills', 'draft-helper'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'draft-helper', 'SKILL.md'), '# draft helper (env skill)\n');
  // Collides with the user's shared-skill — the user must win, this must be skipped.
  mkdirSync(join(envDir, 'skills', 'shared-skill'), { recursive: true });
  writeFileSync(join(envDir, 'skills', 'shared-skill', 'SKILL.md'), '# the ENV shared skill\n');

  mkdirSync(join(envDir, 'agents'), { recursive: true });
  writeFileSync(join(envDir, 'agents', 'draft-agent.md'), '# draft agent\n');
  mkdirSync(join(envDir, 'commands'), { recursive: true });
  writeFileSync(join(envDir, 'commands', 'draft-cmd.md'), '# draft command\n');

  mkdirSync(join(envDir, 'instructions'), { recursive: true });
  writeFileSync(join(envDir, 'instructions', 'writing-rules.md'), '# writing rules\n');

  mkdirSync(join(envDir, 'mcp'), { recursive: true });
  writeFileSync(
    join(envDir, 'mcp', 'servers.yaml'),
    'linear:\n  transport: http\n  url: https://mcp.linear.app/mcp\n  auth: { bearer_env: LINEAR_TOKEN }\n',
  );
}

const homes: LivedInHome[] = [];
function home(): LivedInHome {
  const h = makeLivedInHome();
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) h.cleanup();
});

describe('round-trip integrity (spec criterion 1) — session variant', () => {
  it('binds + composes + exercises + drops a session: zero bytes differ outside ~/.agentenv/ at EVERY step', async () => {
    const h = home();
    const paths = resolvePaths(h.env);
    seedLivedInClaude(h);
    const envDir = paths.envDir('writing');
    seedWritingEnv(envDir);
    writeFileSync(join(envDir, 'instructions', 'base.md'), '# session instructions\n');
    // A project dir the session binds to — part of the stable baseline (it never
    // changes across the session, so it stays inside the byte-identity guarantee).
    const session = 'sh-1';
    const projectRoot = join(h.home, 'proj');
    mkdirSync(projectRoot, { recursive: true });

    // Everything under the test HOME EXCEPT the ~/.agentenv/ store dir.
    const exclude = new Set([paths.base]);
    const step0 = hashTree(h.home, exclude);

    // The foreign-manager symlink's real target, captured to prove it never moves.
    const foreignLink = join(h.claudeHome, 'skills', 'vendor-linked');
    const foreignTarget = readlinkSync(foreignLink);
    const realClaudeJson = readFileSync(h.claudeJson, 'utf8');

    // --- Bind (session): a registry write, which lands under ~/.agentenv only. ---
    await setBinding(paths, { session, projectRoot, envs: ['writing'] });
    expect(hashTree(h.home, exclude)).toBe(step0); // binding leaked nothing

    // --- Compose the private view. ---
    const composed = await composeView({
      paths,
      adapter: claudeAdapter,
      envs: ['writing'],
      session,
      realConfigRoot: h.claudeHome,
      onWarn: () => {},
    });
    expect(composed.rebuilt).toBe(true);
    const view = composed.viewRoot;
    // The real home is byte-identical after compose — the view lives under live/.
    expect(hashTree(h.home, exclude)).toBe(step0);

    // Claude's additional-directory view contains no auth or static real-root
    // links: the child keeps the real config/Keychain layer active independently.
    expect(existsSync(join(view, '.credentials.json'))).toBe(false);
    expect(existsSync(join(view, 'projects'))).toBe(false);

    // Environment skills are private and write through to the store. A same-named
    // user skill remains in the real layer; agentenv does not copy or rewrite it.
    expect(readlinkSync(join(view, '.claude', 'skills', 'draft-helper'))).toBe(
      join(envDir, 'skills', 'draft-helper'),
    );
    expect(readlinkSync(join(view, '.claude', 'skills', 'shared-skill'))).toBe(
      join(envDir, 'skills', 'shared-skill'),
    );
    expect(existsSync(join(view, '.claude', 'skills', 'vendor-linked'))).toBe(false);
    expect(readlinkSync(foreignLink)).toBe(foreignTarget);

    // Additional-directory instructions are a generated CLAUDE.md.
    expect(readFileSync(join(view, 'CLAUDE.md'), 'utf8')).toContain('session instructions');

    // Explicit MCP config contains only the environment server. The user's real
    // ~/.claude.json remains active as a separate native layer.
    const viewCfg = JSON.parse(readFileSync(join(view, '.mcp.json'), 'utf8'));
    expect(Object.keys(viewCfg.mcpServers)).toEqual(['linear']);

    // --- Simulate a session: a WRITE-THROUGH edit to a bucket-2 managed item. ---
    const draftSkill = join(view, '.claude', 'skills', 'draft-helper', 'SKILL.md');
    writeFileSync(draftSkill, '# draft helper (edited mid-session)\n');
    // The edit wrote THROUGH to the store, not the real home.
    expect(readFileSync(join(envDir, 'skills', 'draft-helper', 'SKILL.md'), 'utf8')).toBe(
      '# draft helper (edited mid-session)\n',
    );
    expect(hashTree(h.home, exclude)).toBe(step0); // real home still byte-identical

    // An unrelated edit to the derived explicit MCP file dies with the view and
    // can never alter the user's real internal config.
    viewCfg.sessionOnly = true;
    writeFileSync(join(view, '.mcp.json'), `${JSON.stringify(viewCfg, null, 2)}\n`);
    expect(readFileSync(h.claudeJson, 'utf8')).toBe(realClaudeJson);
    expect(hashTree(h.home, exclude)).toBe(step0);

    // --- Drop / end the session: discard the view + clear the binding. ---
    await clearSession(paths, session);
    rmSync(join(paths.live, session), { recursive: true, force: true });

    // The discarded user-content drift is gone: the real file never received the
    // trust approval (documented D15 quirk), and the whole real home is unchanged.
    const finalClaudeJson = readFileSync(h.claudeJson, 'utf8');
    expect(finalClaudeJson).toBe(realClaudeJson);
    expect(finalClaudeJson.includes('session-trust')).toBe(false);
    // The foreign-manager symlink still points exactly where it did.
    expect(readlinkSync(foreignLink)).toBe(foreignTarget);
    // The strict guarantee: byte-identical outside ~/.agentenv/ at session end.
    expect(hashTree(h.home, exclude)).toBe(step0);
  });
});

describe('round-trip integrity (spec criterion 1) — global variant', () => {
  it('use --global then drop --global --all restores the lived-in home byte-for-byte', async () => {
    const h = home();
    const paths = resolvePaths(h.env);
    seedLivedInClaude(h);
    const envDir = paths.envDir('writing');
    seedWritingEnv(envDir);

    const exclude = new Set([paths.base]);
    const step0 = hashTree(h.home, exclude);
    const foreignLink = join(h.claudeHome, 'skills', 'vendor-linked');
    const foreignTarget = readlinkSync(foreignLink);

    const opts = { env: h.env, adapters: [claudeAdapter] };

    // --- use writing --global: materialise skills/agents/commands/rules COW copies
    //     + .claude.json mcpServers onto the REAL fixture home. ---
    const used = await run(['use', 'writing', '--global'], opts);
    expect(used.code).toBe(0);
    expect(hashTree(h.home, exclude)).not.toBe(step0); // something DID change

    // The env's unique items are retained copies beside the user's content.
    for (const [dir, name, storeSub] of [
      ['skills', 'draft-helper', 'skills'],
      ['agents', 'draft-agent.md', 'agents'],
      ['commands', 'draft-cmd.md', 'commands'],
      ['rules', 'writing-rules.md', 'instructions'], // instructions → rules/ symlink (D2)
    ] as const) {
      const link = join(h.claudeHome, dir, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(false);
      const source = join(envDir, storeSub, name);
      const leaf = name.endsWith('.md') ? '' : 'SKILL.md';
      expect(readFileSync(join(link, leaf), 'utf8')).toBe(readFileSync(join(source, leaf), 'utf8'));
    }

    // The name-colliding env skill is SKIPPED — the user's real skill is untouched,
    // and no env symlink was placed over it.
    expect(readFileSync(join(h.claudeHome, 'skills', 'shared-skill', 'SKILL.md'), 'utf8')).toBe(
      '# the USER shared skill\n',
    );
    expect(lstatSync(join(h.claudeHome, 'skills', 'shared-skill')).isSymbolicLink()).toBe(false);
    // The foreign-manager symlink is untouched (target unchanged).
    expect(readlinkSync(foreignLink)).toBe(foreignTarget);
    // CLAUDE.md (never a global surface for Claude) is untouched.
    expect(readFileSync(join(h.claudeHome, 'CLAUDE.md'), 'utf8')).toBe(
      '# My CLAUDE.md\n\nRemember to be concise.\n',
    );

    // config-keys: linear injected beside context7 (shaped, ${VAR}-passthrough header);
    // the user's onboarding/state keys survive. Read as JSONC — the surgical inject
    // preserved the file's leading comment, so plain JSON.parse would (correctly) choke.
    const cfg = parseJsonc(readFileSync(h.claudeJson, 'utf8'));
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['context7', 'linear']);
    expect(cfg.mcpServers.linear).toEqual({
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' },
    });
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(cfg.numStartups).toBe(42);
    // bucket-1 credentials never touched by global mode.
    expect(readFileSync(join(h.claudeHome, '.credentials.json'), 'utf8')).toBe(
      '{"claudeAiOauth":{"accessToken":"tok"}}\n',
    );

    // The manifest owns items across all three mechanisms for the writing env.
    const manifest = await readState(paths);
    expect(manifest.globalStack).toEqual(['writing']);
    expect(manifest.items.some((i) => i.surface === 'dir-merge')).toBe(true);
    expect(
      manifest.items.some((i) => i.surface === 'config-keys' && i.ownerEnv === 'writing'),
    ).toBe(true);

    // --- drop --global --all: dematerialise everything from the MANIFEST. ---
    const dropped = await run(['drop', '--global', '--all'], opts);
    expect(dropped.code).toBe(0);

    // The strict guarantee: byte-identical outside ~/.agentenv/ — .claude.json
    // formatting + comments restored surgically, the colliding skill and the
    // foreign symlink untouched, CLAUDE.md untouched, no stray files/backups.
    expect(hashTree(h.home, exclude)).toBe(step0);
    const after = await readState(paths);
    expect(after.items).toEqual([]);
    expect(after.globalStack).toEqual([]);
  });
});
