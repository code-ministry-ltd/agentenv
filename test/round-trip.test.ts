import { createHash } from 'node:crypto';
import {
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
import { afterEach, describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude.js';
import { resolvePaths } from '../src/paths.js';
import { composeView } from '../src/session/composer.js';
import { clearSession, setBinding } from '../src/session/registry.js';

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
  agentsHome: string;
  agentenvHome: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function makeLivedInHome(): LivedInHome {
  const home = mkdtempSync(join(tmpdir(), 'agentenv-round-trip-'));
  const claudeHome = join(home, '.claude');
  const agentsHome = join(home, '.agents');
  const agentenvHome = join(home, '.agentenv');
  mkdirSync(agentenvHome, { recursive: true });
  return {
    home,
    claudeHome,
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
  const { claudeHome, agentsHome } = h;

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
    join(claudeHome, '.claude.json'),
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
    const realClaudeJson = readFileSync(join(h.claudeHome, '.claude.json'), 'utf8');

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

    // Bucket 1 (login pass-through): .credentials.json is a symlink to the real file.
    expect(lstatSync(join(view, '.credentials.json')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(view, '.credentials.json'))).toBe(
      join(h.claudeHome, '.credentials.json'),
    );
    // CLAUDE.md and other non-surface state also pass through (bucket 1).
    expect(readlinkSync(join(view, 'CLAUDE.md'))).toBe(join(h.claudeHome, 'CLAUDE.md'));
    expect(readlinkSync(join(view, 'projects'))).toBe(join(h.claudeHome, 'projects'));

    // Bucket 2 — skills: env's unique skill symlinks to the STORE (write-through);
    // the collision resolves to the USER's real skill; the foreign symlink is
    // represented by its real PATH (never un-followed, never rewritten).
    expect(readlinkSync(join(view, 'skills', 'draft-helper'))).toBe(
      join(envDir, 'skills', 'draft-helper'),
    );
    expect(readlinkSync(join(view, 'skills', 'shared-skill'))).toBe(
      join(h.claudeHome, 'skills', 'shared-skill'),
    );
    expect(readlinkSync(join(view, 'skills', 'vendor-linked'))).toBe(foreignLink);
    expect(composed.skipped.some((s) => s.detail.includes('shared-skill'))).toBe(true);

    // Bucket 2 — instructions land in rules/ as a symlink beside the user's rule.
    expect(readlinkSync(join(view, 'rules', 'writing-rules.md'))).toBe(
      join(envDir, 'instructions', 'writing-rules.md'),
    );

    // Bucket 2 — .claude.json seeded from the real file with the env server injected.
    const viewCfg = JSON.parse(readFileSync(join(view, '.claude.json'), 'utf8'));
    expect(Object.keys(viewCfg.mcpServers).sort()).toEqual(['context7', 'linear']);

    // --- Simulate a session: a WRITE-THROUGH edit to a bucket-2 managed item. ---
    const draftSkill = join(view, 'skills', 'draft-helper', 'SKILL.md');
    writeFileSync(draftSkill, '# draft helper (edited mid-session)\n');
    // The edit wrote THROUGH to the store, not the real home.
    expect(readFileSync(join(envDir, 'skills', 'draft-helper', 'SKILL.md'), 'utf8')).toBe(
      '# draft helper (edited mid-session)\n',
    );
    expect(hashTree(h.home, exclude)).toBe(step0); // real home still byte-identical

    // --- Discard rule (D15): a write to LAYERED USER content in a generated file. ---
    // An agent grants a trust approval mid-session by editing the view's .claude.json
    // (a discardable private copy seeded from the real file). This drift is NOT
    // written back — it dies with the view. The real file must never see it.
    viewCfg.projects['/tmp/session-trust'] = { hasTrustDialogAccepted: true };
    writeFileSync(join(view, '.claude.json'), `${JSON.stringify(viewCfg, null, 2)}\n`);
    expect(readFileSync(join(h.claudeHome, '.claude.json'), 'utf8')).toBe(realClaudeJson);
    expect(hashTree(h.home, exclude)).toBe(step0);

    // --- Drop / end the session: discard the view + clear the binding. ---
    await clearSession(paths, session);
    rmSync(join(paths.live, session), { recursive: true, force: true });

    // The discarded user-content drift is gone: the real file never received the
    // trust approval (documented D15 quirk), and the whole real home is unchanged.
    const finalClaudeJson = readFileSync(join(h.claudeHome, '.claude.json'), 'utf8');
    expect(finalClaudeJson).toBe(realClaudeJson);
    expect(finalClaudeJson.includes('session-trust')).toBe(false);
    // The foreign-manager symlink still points exactly where it did.
    expect(readlinkSync(foreignLink)).toBe(foreignTarget);
    // The strict guarantee: byte-identical outside ~/.agentenv/ at session end.
    expect(hashTree(h.home, exclude)).toBe(step0);
  });
});
