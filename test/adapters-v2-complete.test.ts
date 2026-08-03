import { describe, expect, it } from 'vitest';
import { renderSessionLaunch, validateAdapterV2 } from '../src/adapter-v2.js';
import { cursorAdapter } from '../src/adapters/cursor.js';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { piAdapter } from '../src/adapters/pi.js';

describe('remaining Adapter v2 definitions', () => {
  it.each([opencodeAdapter, piAdapter, cursorAdapter])(
    '$id has a complete valid v2 contract',
    (adapter) => {
      expect(adapter.definition).toBeDefined();
      expect(validateAdapterV2(adapter.definition!)).toBeNull();
    },
  );

  it('isolates OpenCode with XDG_CONFIG_HOME and keeps the redundant merge root aligned', () => {
    expect(renderSessionLaunch(opencodeAdapter.definition!, '/live/gen/opencode', [])).toEqual({
      args: [],
      env: {
        XDG_CONFIG_HOME: '/live/gen',
        OPENCODE_CONFIG_DIR: '/live/gen/opencode',
      },
    });
  });

  it.each([opencodeAdapter, piAdapter, cursorAdapter])(
    '$id sends global skills to the shared agents-standard root',
    (adapter) => {
      const skills = adapter.definition!.surfaces.find((surface) => surface.id === 'skills');
      expect(skills?.global).toMatchObject({
        supported: true,
        destination: { root: 'agents-standard', relativePath: '' },
        writer: 'projection',
      });
    },
  );

  it('keeps Cursor explicitly global-only in both launch and logical surfaces', () => {
    expect(cursorAdapter.definition?.session).toMatchObject({ supported: false });
    expect(
      cursorAdapter.definition?.surfaces.every((surface) => !surface.session.supported),
    ).toBe(true);
  });
});
