import { describe, expect, it } from 'vitest';
import {
  EnvYamlError,
  SCHEMA_VERSION,
  SCHEMA_VERSION_STRING,
  parseEnvConfig,
  scaffoldEnvYaml,
} from '../src/env-config.js';

const FILE = '/store/environments/writing/env.yaml';

describe('parseEnvConfig', () => {
  it('reads version, description, notes and capture ignore patterns', () => {
    const cfg = parseEnvConfig(
      [
        'version: "1.0"',
        'description: writing environment',
        'notes: my notes',
        'capture:',
        '  ignore:',
        '    - "**/*.log"',
        '    - node_modules',
      ].join('\n'),
      FILE,
    );
    expect(cfg.version).toBe('1.0');
    expect(cfg.description).toBe('writing environment');
    expect(cfg.notes).toBe('my notes');
    expect(cfg.capture?.ignore).toEqual(['**/*.log', 'node_modules']);
  });

  it('tolerates unknown fields (forward compatibility)', () => {
    const cfg = parseEnvConfig(
      ['version: "1.0"', 'description: d', 'futureField: whatever'].join('\n'),
      FILE,
    );
    expect(cfg.description).toBe('d');
    expect(cfg['futureField']).toBe('whatever');
  });

  it('accepts a newer MINOR version', () => {
    const cfg = parseEnvConfig(
      [`version: "${SCHEMA_VERSION.major}.${SCHEMA_VERSION.minor + 5}"`, 'description: d'].join(
        '\n',
      ),
      FILE,
    );
    expect(cfg.version).toBe(`${SCHEMA_VERSION.major}.${SCHEMA_VERSION.minor + 5}`);
  });

  it('rejects a newer MAJOR version with an upgrade message (not a schema error)', () => {
    expect(() =>
      parseEnvConfig(
        [`version: "${SCHEMA_VERSION.major + 1}.0"`, 'description: d'].join('\n'),
        FILE,
      ),
    ).toThrow(/store newer than CLI — upgrade agentenv/);
  });

  it('accepts a YAML-number version and normalises it to major.minor', () => {
    const cfg = parseEnvConfig(['version: 1', 'description: d'].join('\n'), FILE);
    expect(cfg.version).toBe('1.0');
  });

  it('names the file and line on malformed YAML', () => {
    let thrown: unknown;
    try {
      parseEnvConfig(['version: "1.0"', 'description: d', 'capture: [unclosed'].join('\n'), FILE);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EnvYamlError);
    const e = thrown as EnvYamlError;
    expect(e.file).toBe(FILE);
    expect(e.line).toBeTypeOf('number');
    expect(e.message).toMatch(/env\.yaml:\d+/);
  });

  it('rejects a missing version field, naming the file', () => {
    let thrown: unknown;
    try {
      parseEnvConfig('description: d\n', FILE);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EnvYamlError);
    expect((thrown as EnvYamlError).message).toContain('env.yaml');
    expect((thrown as EnvYamlError).message).toMatch(/version/);
  });

  it('rejects a top-level YAML that is not a mapping', () => {
    expect(() => parseEnvConfig('- just\n- a\n- list\n', FILE)).toThrow(EnvYamlError);
  });
});

describe('scaffoldEnvYaml', () => {
  it('renders a valid manifest at the current schema version that round-trips', () => {
    const text = scaffoldEnvYaml({ description: 'writing environment' });
    const cfg = parseEnvConfig(text, FILE);
    expect(cfg.version).toBe(SCHEMA_VERSION_STRING);
    expect(cfg.description).toBe('writing environment');
  });

  it('escapes a description containing YAML-special characters', () => {
    const tricky = ': weird #value "quoted"';
    const cfg = parseEnvConfig(scaffoldEnvYaml({ description: tricky }), FILE);
    expect(cfg.description).toBe(tricky);
  });
});
