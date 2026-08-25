'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run, buildArgv } = require('./second-opinion');
const { withDefaults } = require('./lib/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'second-opinion-'));
const wired = (command) => withDefaults({ review: { secondOpinion: { command } } });
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('placeholders are substituted as whole argv elements', () => {
  // Never by splicing a string: a path with a space is one argument, not two.
  const argv = buildArgv(['codex', 'exec', '--out', '{outputFile}', '{promptFile}'], {
    promptFile: '/tmp/a b/prompt.md',
    outputFile: '/tmp/out.json',
  });

  assert.deepEqual(argv, ['codex', 'exec', '--out', '/tmp/out.json', '/tmp/a b/prompt.md']);
});

test('no configured command is a skip that says what you are missing', () => {
  const dir = tmp();
  const out = path.join(dir, 'second.json');

  const result = run(withDefaults({}), { promptFile: 'p.md', outputFile: out });

  assert.equal(result.status, 'skipped');
  assert.match(read(out).hint, /one reviewer with one blind spot/);
});

test('a missing binary is a skip, not a failure', () => {
  // The plugin is a personal install. A push must not depend on it.
  const dir = tmp();
  const out = path.join(dir, 'second.json');

  const result = run(wired(['definitely-not-installed-xyz', '{promptFile}']), {
    promptFile: 'p.md',
    outputFile: out,
    spawn: () => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }),
  });

  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /not installed/);
});

test('a hung reviewer is a skip, not a held push', () => {
  const dir = tmp();
  const out = path.join(dir, 'second.json');

  const result = run(wired(['slow', '{promptFile}']), {
    promptFile: 'p.md',
    outputFile: out,
    timeoutMs: 1000,
    spawn: () => ({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }),
  });

  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /did not finish within 1s/);
});

test('a non-zero exit carries its stderr into the reason', () => {
  const dir = tmp();
  const out = path.join(dir, 'second.json');

  const result = run(wired(['codex', '{promptFile}']), {
    promptFile: 'p.md',
    outputFile: out,
    spawn: () => ({ status: 1, stdout: '', stderr: 'not authenticated' }),
  });

  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /exited 1/);
  assert.match(result.hint, /not authenticated/);
});

test('stdout becomes the review when the command writes nothing itself', () => {
  const dir = tmp();
  const out = path.join(dir, 'second.json');

  const result = run(wired(['codex', '{promptFile}']), {
    promptFile: 'p.md',
    outputFile: out,
    spawn: () => ({ status: 0, stdout: 'the retry loop assumes idempotency', stderr: '' }),
  });

  assert.equal(result.status, 'ok');
  assert.match(read(out).output, /idempotency/);
});

test('a command that wrote the output file keeps what it wrote', () => {
  const dir = tmp();
  const out = path.join(dir, 'second.json');

  const result = run(wired(['codex', '--out', '{outputFile}']), {
    promptFile: 'p.md',
    outputFile: out,
    // The real thing writes the file while it runs, so the stub must too.
    spawn: () => {
      fs.writeFileSync(out, 'findings the tool wrote itself');
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(result.status, 'ok');
  assert.match(read(out).output, /wrote itself/);
});

test('a previous run left behind is never reported as this run', () => {
  // Found by running the thing twice: the second call read the first call's
  // skip JSON off disk and returned it as a fresh review, status "ok".
  const dir = tmp();
  const out = path.join(dir, 'second.json');
  fs.writeFileSync(out, JSON.stringify({ status: 'skipped', reason: 'from an earlier run' }));

  const result = run(wired(['codex', '{promptFile}']), {
    promptFile: 'p.md',
    outputFile: out,
    spawn: () => ({ status: 0, stdout: 'this run found a real problem', stderr: '' }),
  });

  assert.equal(result.status, 'ok');
  assert.match(read(out).output, /this run found a real problem/);
  assert.doesNotMatch(read(out).output, /earlier run/);
});

test('a command that writes nothing is a skip even when a stale file exists', () => {
  const dir = tmp();
  const out = path.join(dir, 'second.json');
  fs.writeFileSync(out, 'stale review from last time');

  const result = run(wired(['codex', '{promptFile}']), {
    promptFile: 'p.md',
    outputFile: out,
    spawn: () => ({ status: 0, stdout: '', stderr: '' }),
  });

  assert.equal(result.status, 'skipped');
});

test('silence is a skip, so "found nothing" is never confused with "never ran"', () => {
  const dir = tmp();
  const out = path.join(dir, 'second.json');

  const result = run(wired(['codex', '{promptFile}']), {
    promptFile: 'p.md',
    outputFile: out,
    spawn: () => ({ status: 0, stdout: '   ', stderr: '' }),
  });

  assert.equal(result.status, 'skipped');
});

test('it really runs a real command, without a shell', () => {
  const dir = tmp();
  const out = path.join(dir, 'second.json');

  // `;` and backticks would be syntax under a shell. Here they are just text.
  const result = run(wired([process.execPath, '-e', 'process.stdout.write("hi; `whoami`")']), {
    promptFile: 'p.md',
    outputFile: out,
  });

  assert.equal(result.status, 'ok');
  assert.equal(read(out).output, 'hi; `whoami`');
});
