import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../src/config-keys.js';
import { resolvePaths } from '../src/paths.js';
import {
  loadResolver,
  makeResolver,
  maskSecret,
  parseSecretsEnv,
  serializeSecretsEnv,
  substituteSecretFields,
  substituteString,
  writeSecrets,
} from '../src/secrets.js';
import { makeTempHome } from './helpers.js';

describe('secrets: parseSecretsEnv', () => {
  it('parses KEY=value, ignoring comments and blank lines', () => {
    const m = parseSecretsEnv('# a comment\n\nFOO=bar\n  \nBAZ=qux\n');
    expect(m.get('FOO')).toBe('bar');
    expect(m.get('BAZ')).toBe('qux');
    expect(m.size).toBe(2);
  });

  it('trims whitespace around the = and the key/value', () => {
    const m = parseSecretsEnv('  FOO =  bar baz  ');
    // Unquoted value keeps interior spaces but is trimmed at the ends.
    expect(m.get('FOO')).toBe('bar baz');
  });

  it('honours single quotes literally and double quotes with escapes', () => {
    const m = parseSecretsEnv(['LIT=\'a#b c\'', 'ESC="line1\\nline2\\t\\"q\\""'].join('\n'));
    expect(m.get('LIT')).toBe('a#b c');
    expect(m.get('ESC')).toBe('line1\nline2\t"q"');
  });

  it('strips a trailing inline comment from an unquoted value only', () => {
    const m = parseSecretsEnv('FOO=bar # trailing\nHASH="v#1"\nBARE=a#b');
    expect(m.get('FOO')).toBe('bar');
    expect(m.get('HASH')).toBe('v#1'); // quoted: hash kept
    expect(m.get('BARE')).toBe('a#b'); // no whitespace before #: kept
  });

  it('supports an optional export prefix', () => {
    const m = parseSecretsEnv('export TOKEN=abc123');
    expect(m.get('TOKEN')).toBe('abc123');
  });

  it('skips invalid keys and lines with no =', () => {
    const m = parseSecretsEnv('1BAD=x\nnope\nGOOD=y\nhas space=z');
    expect(m.has('1BAD')).toBe(false);
    expect(m.has('has space')).toBe(false);
    expect(m.get('GOOD')).toBe('y');
    expect(m.size).toBe(1);
  });

  it('lets a later assignment win', () => {
    expect(parseSecretsEnv('K=1\nK=2').get('K')).toBe('2');
  });
});

describe('secrets: resolver precedence', () => {
  it('resolves secrets.env first, then the shell env, else undefined', () => {
    const secrets = new Map([['A', 'from-secrets']]);
    const env = { A: 'from-env', B: 'env-only' } as NodeJS.ProcessEnv;
    const r = makeResolver(secrets, env);
    expect(r.resolve('A')).toBe('from-secrets'); // secrets wins
    expect(r.resolve('B')).toBe('env-only'); // falls through to env
    expect(r.resolve('MISSING')).toBeUndefined();
  });

  it('loadResolver reads secrets.env from paths and layers the env', async () => {
    const home = makeTempHome();
    try {
      const paths = resolvePaths(home.env);
      await writeSecrets(paths, new Map([['TOK', 'secret-value']]));
      const r = await loadResolver(paths, { OTHER: 'x' } as NodeJS.ProcessEnv);
      expect(r.resolve('TOK')).toBe('secret-value');
      expect(r.resolve('OTHER')).toBe('x');
    } finally {
      home.cleanup();
    }
  });

  it('a missing secrets.env resolves to an empty map, not an error', async () => {
    const home = makeTempHome();
    try {
      const r = await loadResolver(resolvePaths(home.env), {} as NodeJS.ProcessEnv);
      expect(r.resolve('ANY')).toBeUndefined();
    } finally {
      home.cleanup();
    }
  });
});

describe('secrets: substituteString', () => {
  const resolve = (n: string): string | undefined => (n === 'TOK' ? 'sekret' : undefined);

  it('replaces resolved ${VAR}, embedded or standalone', () => {
    expect(substituteString('${TOK}', resolve).text).toBe('sekret');
    expect(substituteString('Bearer ${TOK}', resolve).text).toBe('Bearer sekret');
    expect(substituteString('https://x/${TOK}/y', resolve).text).toBe('https://x/sekret/y');
  });

  it('leaves an unresolved ${VAR} verbatim and reports it', () => {
    const res = substituteString('a-${NOPE}-b', resolve);
    expect(res.text).toBe('a-${NOPE}-b');
    expect(res.unresolved).toEqual(['NOPE']);
  });

  it('collects each distinct unresolved name once', () => {
    const res = substituteString('${X}${Y}${X}', resolve);
    expect(res.unresolved).toEqual(['X', 'Y']);
  });
});

describe('secrets: substituteSecretFields', () => {
  const resolve = (n: string): string | undefined =>
    ({ TOKEN: 'tkn', AUTH: 'auth' })[n];

  it('resolves only flagged subfields and deep-clones (no mutation)', () => {
    interface Server {
      command: string;
      env: { TOKEN: string };
      headers: { Authorization: string };
      note: string;
    }
    const value: JsonValue = {
      command: 'server',
      env: { TOKEN: '${TOKEN}' },
      headers: { Authorization: 'Bearer ${AUTH}' },
      note: '${TOKEN}', // NOT flagged → must stay a placeholder
    };
    const { value: outValue, unresolved } = substituteSecretFields(
      value,
      { 'env.TOKEN': '${TOKEN}', 'headers.Authorization': 'Bearer ${AUTH}' },
      resolve,
    );
    const out = outValue as unknown as Server;
    expect(unresolved).toEqual([]);
    expect(out.env.TOKEN).toBe('tkn');
    expect(out.headers.Authorization).toBe('Bearer auth');
    // Unflagged field untouched; original object not mutated.
    expect(out.note).toBe('${TOKEN}');
    expect((value as unknown as Server).env.TOKEN).toBe('${TOKEN}');
  });

  it('reports unresolved vars from any flagged subfield', () => {
    const { unresolved } = substituteSecretFields(
      { env: { A: '${MISSING}' } } as JsonValue,
      { 'env.A': '${MISSING}' },
      resolve,
    );
    expect(unresolved).toEqual(['MISSING']);
  });
});

describe('secrets: masking + write', () => {
  it('maskSecret never reveals the value', () => {
    expect(maskSecret('super-secret-token')).not.toContain('secret');
    expect(maskSecret('super-secret-token')).toMatch(/^•+$/);
    expect(maskSecret('')).toBe('(empty)');
  });

  it('serialize round-trips through parse, quoting when needed', () => {
    const m = new Map([
      ['PLAIN', 'abc123'],
      ['SPACED', 'a b c'],
      ['HASHY', 'v#1'],
      ['NEWLINE', 'a\nb'],
    ]);
    const round = parseSecretsEnv(serializeSecretsEnv(m));
    expect(round.get('PLAIN')).toBe('abc123');
    expect(round.get('SPACED')).toBe('a b c');
    expect(round.get('HASHY')).toBe('v#1');
    expect(round.get('NEWLINE')).toBe('a\nb');
  });

  it('writeSecrets writes 0600-permissioned file content', async () => {
    const home = makeTempHome();
    try {
      const paths = resolvePaths(home.env);
      await writeSecrets(paths, new Map([['K', 'v']]));
      expect(readFileSync(paths.secrets, 'utf8')).toBe('K=v\n');
      // Owner-only permissions (skip the assertion where the platform can't chmod).
      const mode = statSync(paths.secrets).mode & 0o777;
      if (process.platform !== 'win32') expect(mode).toBe(0o600);
    } finally {
      home.cleanup();
    }
  });
});
