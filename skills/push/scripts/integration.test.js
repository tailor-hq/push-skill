'use strict';

/**
 * The only tests here that touch real git.
 *
 * Everything else exercises pure functions, which means the plumbing between
 * them and git was untested: the three-dot diff, the ref argument, worktree
 * resolution, the CLIs' exit codes. That plumbing is where version and platform
 * differences show up, and it is what the Node matrix in CI exists to cover.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/** A repo with a main branch and a feature branch that changed two areas. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-skill-it-'));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e',
        GIT_CONFIG_GLOBAL: path.join(dir, 'gitconfig'), GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });

  const write = (file, body) => {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  };

  git('init', '-q', '-b', 'main');
  write('push.config.json', JSON.stringify({
    git: { base: 'main' },
    ignore: ['docs/**'],
    checks: { app: { command: 'npm test', description: 'unit', paths: ['src/**'] } },
    suites: { flow: { command: 'e2e', description: 'flow', paths: ['e2e/**'] } },
    e2e: { unmapped: 'none', mainBranchSafetyNet: { description: 'hourly on main' } },
    coverage: { areas: [{ name: 'src', paths: ['src/**'] }], exempt: [] },
  }, null, 2));
  write('src/a.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');

  git('checkout', '-q', '-b', 'feature');
  write('src/b.ts', 'export const b = 2;\n');
  write('docs/note.md', 'ignored\n');
  git('add', '-A');
  git('commit', '-qm', 'feature work');

  // main moves on, which is what makes two-dot and three-dot diffs differ.
  git('checkout', '-q', 'main');
  write('src/unrelated.ts', 'export const c = 3;\n');
  git('add', '-A');
  git('commit', '-qm', 'unrelated work on main');
  git('checkout', '-q', 'feature');

  return { dir, git, write };
}

const runScript = (dir, script, args = []) =>
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], { cwd: dir, encoding: 'utf8' });

test('the selector reads a real diff and ignores what the config ignores', () => {
  const { dir } = repo();
  const result = runScript(dir, 'select-checks.js');

  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);

  assert.deepEqual(out.checks, ['app']);
  assert.deepEqual(out.suites, [], 'nothing under e2e/ changed');
  assert.equal(out.changedFiles, 1, 'docs/note.md is ignored');
  assert.equal(out.ignoredFiles, 1);
});

test('the diff is three-dot, so unrelated work on main is not attributed to the branch', () => {
  // Two dots would report src/unrelated.ts as removed by this branch.
  const { dir } = repo();
  const out = JSON.parse(runScript(dir, 'select-checks.js').stdout);

  assert.equal(out.changedFiles, 1);
});

test('the coverage gate exits non-zero on a real gap under --strict', () => {
  const { dir } = repo();
  const result = runScript(dir, 'assess-test-coverage.js', ['--strict']);

  assert.equal(result.status, 1, 'src changed with no test');
  assert.equal(JSON.parse(result.stdout).verdict, 'gaps');
});

test('adding the test clears the gate', () => {
  const { dir, git, write } = repo();
  write('src/b.test.ts', 'test("b", () => {});\n');
  git('add', '-A');
  git('commit', '-qm', 'test for b');

  const result = runScript(dir, 'assess-test-coverage.js', ['--strict']);

  assert.equal(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).verdict, 'tested');
});

test('a missing config fails with a message that says what to run', () => {
  const { dir } = repo();
  fs.unlinkSync(path.join(dir, 'push.config.json'));

  const result = runScript(dir, 'select-checks.js');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /init-config\.js/);
});

test('init-config writes a config a real repo can use', () => {
  const { dir } = repo();
  fs.unlinkSync(path.join(dir, 'push.config.json'));

  assert.equal(runScript(dir, 'init-config.js').status, 0);

  const written = JSON.parse(fs.readFileSync(path.join(dir, 'push.config.json'), 'utf8'));
  assert.equal(written.git.base, 'main', 'no origin here, so it falls back to the local branch');
  assert.equal(written.e2e.unmapped, 'all', 'the safe default, absent a declared safety net');
});

test('the session lock is per worktree and refuses a second run', () => {
  const { dir } = repo();

  const first = runScript(dir, 'session.js', ['start']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout.trim(), /\.git[\\/]push-skill[\\/]run-/);
  assert.ok(fs.existsSync(first.stdout.trim()), 'the scratch directory really exists');

  const second = runScript(dir, 'session.js', ['start']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Another push is already running/);

  assert.equal(runScript(dir, 'session.js', ['end']).status, 0);
  assert.equal(runScript(dir, 'session.js', ['start']).status, 0, 'released');
});

test('scratch state never shows up in git status', () => {
  // It lives under .git/, so it cannot be swept into a commit by a later step.
  const { dir, git } = repo();
  runScript(dir, 'session.js', ['start']);

  assert.equal(git('status', '--porcelain').trim(), '');
});
