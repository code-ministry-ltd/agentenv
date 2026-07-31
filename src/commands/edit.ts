import { parseArgs } from '../args.js';
import type { Command } from '../command.js';
import { launchEditorDefault } from '../editor.js';
import { environmentExists, validateEnvName } from '../store.js';

function configuredEditor(env: NodeJS.ProcessEnv): string | undefined {
  const visual = env.VISUAL?.trim();
  if (visual) return visual;
  const editor = env.EDITOR?.trim();
  if (editor) return editor;
  return undefined;
}

export const editCommand: Command = {
  name: 'edit',
  usage: '<name> [--print-path]',
  summary: "Edit an environment's manifest in $EDITOR",

  async run({ args, paths, env, options }) {
    const parsed = parseArgs(args, { booleans: ['print-path'] });
    if (parsed.unknown.length > 0) {
      return { stdout: '', stderr: `edit: unknown option '${parsed.unknown[0]}'\n`, code: 1 };
    }
    const name = parsed.positionals[0];
    if (name === undefined) {
      return { stdout: '', stderr: 'edit: missing environment name\nUsage: agentenv edit <name> [--print-path]\n', code: 1 };
    }
    // Validate before any path join, so `edit ../../x` can't open a file outside the store.
    const nameError = validateEnvName(name);
    if (nameError) {
      return { stdout: '', stderr: `edit: ${nameError}\n`, code: 1 };
    }
    if (!(await environmentExists(paths, name))) {
      return { stdout: '', stderr: `edit: environment '${name}' does not exist\n`, code: 1 };
    }

    const file = paths.envYaml(name);

    if (parsed.booleans.has('print-path')) {
      return { stdout: `${file}\n`, code: 0 };
    }

    const editor = configuredEditor(env);
    const [command, ...editorArgs] = editor ? editor.split(/\s+/).filter(Boolean) : [];
    if (command === undefined) {
      return {
        stdout: `No $VISUAL or $EDITOR set. Edit this file directly:\n${file}\n`,
        code: 0,
      };
    }

    const launch = options.launchEditor ?? launchEditorDefault;
    const exitCode = await launch(command, [...editorArgs, file]);
    if (exitCode !== 0) {
      return { stdout: '', stderr: `edit: editor exited with code ${exitCode}\n`, code: exitCode };
    }
    return { stdout: '', code: 0 };
  },
};
