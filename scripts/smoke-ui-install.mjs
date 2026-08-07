#!/usr/bin/env node
/* global fetch */

import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL, URL, URLSearchParams } from 'node:url';

const [bin, agentenvHome, sandboxHome, workRoot] = process.argv.slice(2);
if (!bin || !agentenvHome || !sandboxHome || !workRoot) {
  throw new Error('usage: smoke-ui-install.mjs <bin> <agentenv-home> <home> <work-root>');
}

const uiTmp = await mkdtemp(join(workRoot, 'ui-tmp-'));
const childEnv = {
  ...process.env,
  AGENTENV_HOME: agentenvHome,
  AGENTENV_SESSION: `ui-smoke-${process.pid}`,
  GIT_CONFIG_GLOBAL: join(sandboxHome, '.gitconfig'),
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  HOME: sandboxHome,
  TMPDIR: uiTmp,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function startInstalledUi(extraArgs = [], env = childEnv) {
  const child = spawn(bin, ['--offline', 'ui', '--no-open', ...extraArgs], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, output: () => ({ stdout, stderr }) };
}

async function waitForLaunch(started) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = /agentenv UI: (http:\/\/127\.0\.0\.1:\d+\/#launch=[A-Za-z0-9_-]+)/
      .exec(started.output().stdout);
    if (match) return match[1];
    if (started.child.exitCode !== null) {
      throw new Error(`installed UI exited before launch: ${JSON.stringify(started.output())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`installed UI did not print a launch URL: ${JSON.stringify(started.output())}`);
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('installed UI process did not exit')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function json(response) {
  const body = await response.json();
  if (!response.ok || body?.data === undefined) {
    throw new Error(`UI request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body.data;
}

async function assertTokenAbsent(root, token) {
  async function walk(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.git') await walk(child);
      } else if (entry.isFile() && (await stat(child)).size <= 1_000_000) {
        const content = await readFile(child).catch(() => Buffer.alloc(0));
        assert(!content.includes(token), `launch credential persisted in ${child}`);
      }
    }
  }
  await walk(root);
}

let started;
try {
  started = startInstalledUi();
  const launchUrl = await waitForLaunch(started);
  const parsedLaunch = new URL(launchUrl);
  const origin = parsedLaunch.origin;
  const launchToken = new URLSearchParams(parsedLaunch.hash.slice(1)).get('launch');
  assert(launchToken, 'launch URL did not contain a credential');

  const sessionResponse = await fetch(`${origin}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ launchToken }),
  });
  const session = await json(sessionResponse);
  const cookie = sessionResponse.headers.get('set-cookie');
  assert(cookie, 'session exchange did not set a cookie');
  const mutationHeaders = {
    cookie,
    origin,
    'content-type': 'application/json',
    'x-agentenv-csrf': session.csrfToken,
  };
  const api = async (path, options = {}) => await json(await fetch(`${origin}${path}`, {
    ...options,
    headers: options.method && options.method !== 'GET'
      ? { ...mutationHeaders, ...options.headers }
      : { cookie, ...options.headers },
  }));

  const rootAsset = await fetch(origin);
  assert(rootAsset.ok && (await rootAsset.text()).includes('<div id="root">'),
    'installed UI assets were not served');
  const catalog = await api('/api/environments?page=1&pageSize=100');
  assert(catalog.items.some((environment) => environment.name === 'writing'),
    'installed UI could not browse the restored environment');

  await api('/api/environments', {
    method: 'POST',
    body: JSON.stringify({
      operation: 'create',
      name: 'ui-smoke',
      description: 'Packed UI smoke environment',
    }),
  });
  let source = await api('/api/environments/writing');
  let destination = await api('/api/environments/ui-smoke');
  const sourceItem = source.items.find(
    (item) => item.kind === 'skill' && item.name === 'tone-of-voice',
  );
  assert(sourceItem, 'source skill was not visible to the installed UI');
  await api('/api/content/transfer', {
    method: 'POST',
    body: JSON.stringify({
      operation: 'copy',
      kind: 'skill',
      name: sourceItem.name,
      sourceEnvironment: source.name,
      destinationEnvironment: destination.name,
      collision: 'fail',
      sourceItemRevision: sourceItem.revision,
      sourceEnvironmentRevision: source.revision,
      sourceEnvironmentContainerRevision: source.containerRevision,
      destinationEnvironmentRevision: destination.revision,
      destinationEnvironmentContainerRevision: destination.containerRevision,
      destinationItemRevision: null,
    }),
  });

  const document = await api('/api/environments/ui-smoke/skills/tone-of-voice/document');
  await api('/api/environments/ui-smoke/skills/tone-of-voice/document', {
    method: 'PUT',
    body: JSON.stringify({
      environment: 'ui-smoke',
      skill: 'tone-of-voice',
      expectedRevision: document.revision,
      text: `${document.text.trimEnd()}\n\nSMOKE-UI-EDITED\n`,
    }),
  });

  const repo = join(workRoot, 'ui-skill-repo');
  const importedSkill = join(repo, 'skills', 'git-imported');
  await mkdir(importedSkill, { recursive: true });
  await writeFile(join(importedSkill, 'SKILL.md'), [
    '---',
    'name: git-imported',
    'description: Imported by the packed UI smoke.',
    '---',
    '',
    '# Packed Git import',
    '',
  ].join('\n'));
  git(repo, ['init', '-b', 'main']);
  git(repo, ['add', '--', '.']);
  git(repo, [
    '-c', 'user.name=agentenv smoke',
    '-c', 'user.email=smoke@agentenv.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '-m', 'skill fixture',
  ]);
  const pending = await api('/api/git/candidates', {
    method: 'POST',
    body: JSON.stringify({ source: pathToFileURL(join(repo, 'skills')).href }),
  });
  let candidates;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    candidates = await api(`/api/git/candidates/${pending.candidateSetId}?page=1&pageSize=100`);
    if (candidates.status !== 'PENDING') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(candidates?.status === 'READY', 'local Git candidate discovery did not complete');
  const selected = candidates.candidates.find((candidate) => candidate.name === 'git-imported');
  assert(selected, 'local Git skill was not discovered');
  const imported = await api('/api/git/import', {
    method: 'POST',
    body: JSON.stringify({
      candidateSetId: candidates.candidateSetId,
      environment: 'ui-smoke',
      selections: [{ candidateId: selected.candidateId, collision: 'skip' }],
    }),
  });
  assert(imported.outcomes.some(
    (outcome) => outcome.name === 'git-imported' && outcome.status === 'installed'),
  'selected local Git skill was not installed');

  destination = await api('/api/environments/ui-smoke');
  assert(destination.items.some((item) => item.kind === 'skill' && item.name === 'git-imported'),
    'imported skill was not visible after publication');
  const editedText = await readFile(
    join(agentenvHome, 'store', 'environments', 'ui-smoke', 'skills', 'tone-of-voice', 'SKILL.md'),
    'utf8',
  );
  assert(editedText.includes('SMOKE-UI-EDITED'), 'skill edit was not published');

  await api('/api/environments', {
    method: 'POST',
    body: JSON.stringify({
      operation: 'delete',
      name: destination.name,
      confirmation: destination.name,
      targetRevision: destination.revision,
      containerRevision: destination.containerRevision,
    }),
  });
  await access(join(agentenvHome, 'store', 'environments', 'ui-smoke'))
    .then(() => { throw new Error('deleted environment still exists'); })
    .catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });

  started.child.kill('SIGTERM');
  const stopped = await waitForExit(started.child);
  assert(stopped.code === 143 || stopped.signal === 'SIGTERM',
    `installed UI did not stop cleanly: ${JSON.stringify(stopped)}`);
  await fetch(origin).then(
    () => { throw new Error('installed UI listener survived shutdown'); },
    () => undefined,
  );
  assert((await readdir(uiTmp)).length === 0, 'UI shutdown left temporary Git content');
  await assertTokenAbsent(agentenvHome, launchToken);

  const occupied = createServer((_request, response) => response.end('occupied'));
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  const address = occupied.address();
  assert(address && typeof address !== 'string', 'could not reserve a startup-failure port');
  const failedHome = join(workRoot, 'ui-failed-start');
  await mkdir(failedHome, { recursive: true });
  const failed = startInstalledUi(['--port', String(address.port)], {
    ...childEnv,
    AGENTENV_HOME: failedHome,
  });
  const failure = await waitForExit(failed.child);
  await new Promise((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  assert(failure.code === 1, `occupied-port startup returned ${JSON.stringify(failure)}`);
  assert(!failed.output().stdout.includes('#launch='), 'failed startup exposed a launch credential');
  assert((await readdir(failedHome)).length === 0, 'failed startup wrote agentenv state');
  assert((await readdir(uiTmp)).length === 0, 'failed startup left temporary content');
} finally {
  if (started && started.child.exitCode === null && started.child.signalCode === null) {
    started.child.kill('SIGKILL');
    await waitForExit(started.child).catch(() => undefined);
  }
  await rm(uiTmp, { recursive: true, force: true });
}
