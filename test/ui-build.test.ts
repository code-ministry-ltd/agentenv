import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { UserConfig } from 'vite';
import viteConfig from '../vite.config.js';

interface PackageJson {
  files?: readonly string[];
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe('UI production build contract', () => {
  it('keeps UI output isolated inside the packaged dist directory', () => {
    const config = viteConfig as UserConfig;

    expect(config.root).toBe('ui');
    expect(config.build).toMatchObject({
      assetsDir: 'assets',
      emptyOutDir: true,
      outDir: '../dist/ui-assets',
      sourcemap: false,
    });
  });

  it('pins the approved toolchain and builds server before browser assets', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as PackageJson;

    expect(packageJson.files).toContain('dist');
    expect(packageJson.scripts).toMatchObject({
      build: 'npm run build:server && npm run build:ui',
      'build:server': 'tsc -p tsconfig.json',
      'build:ui': 'vite build',
    });
    expect(packageJson.devDependencies).toMatchObject({
      '@vitejs/plugin-react': '6.0.5',
      react: '19.2.7',
      'react-dom': '19.2.7',
      vite: '8.2.1',
    });
  });
});
