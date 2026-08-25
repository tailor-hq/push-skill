'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { select } = require('./select-checks');
const { matches } = require('./lib/match');

const config = {
  ignore: ['docs/**', '**/*.md'],
  e2e: { unmapped: 'none' },
  checks: {
    app: { command: 'npm run verify', description: 'build, lint, unit', paths: ['src/**'] },
    tooling: { command: 'npm run test:scripts', description: 'repo tooling', paths: ['scripts/**', '.github/**'] },
  },
  suites: {
    checkout: { command: 'npm run e2e -- checkout', description: 'checkout flow', paths: ['src/checkout/**'] },
  },
};

test('glob matching handles the four forms a path map needs', () => {
  assert.ok(matches('src/a/b/c.ts', 'src/**'));
  assert.ok(matches('src/c.ts', 'src/**/*.ts'), '**/ must match zero directories');
  assert.ok(matches('a.tsx', '*.{ts,tsx}'));
  assert.ok(!matches('src/a/b.ts', 'src/*.ts'), '* must not cross a slash');
});

test('selects the families a diff can reach, and no others', () => {
  const result = select(['src/checkout/cart.ts'], config);

  assert.deepEqual(result.checks, ['app']);
  assert.deepEqual(result.suites, ['checkout']);
  assert.equal(result.checksRequired, true);
});

test('an unmapped path selects EVERY check family', () => {
  // The asymmetry this whole script exists for. Nothing re-runs build, lint or
  // unit after a merge, so a path nobody mapped has to pull in everything.
  const result = select(['infra/terraform/main.tf'], config);

  assert.deepEqual(result.checks, ['app', 'tooling']);
  assert.deepEqual(result.unmapped, ['infra/terraform/main.tf']);
  assert.ok(result.checkReasons.some((reason) => reason.includes('match no rule')));
});

test('an unmapped path selects NO e2e suite when the config opted out', () => {
  // Only legitimate when e2e.mainBranchSafetyNet says what runs the suite later.
  const result = select(['infra/terraform/main.tf'], config);

  assert.deepEqual(result.suites, []);
});

test('an unmapped path selects EVERY e2e suite by default', () => {
  // The safe default for a repo we know nothing about: assume nothing catches
  // it after a merge.
  const safe = { ...config, e2e: { unmapped: 'all' } };
  const result = select(['infra/terraform/main.tf'], safe);

  assert.deepEqual(result.suites, ['checkout']);
  assert.ok(result.reasons.some((r) => r.includes('match no e2e rule')));
});

test('ignored paths select nothing at all', () => {
  const result = select(['docs/adr/0001-why.md', 'README.md'], config);

  assert.deepEqual(result.checks, []);
  assert.deepEqual(result.suites, []);
  assert.equal(result.checksRequired, false);
  assert.equal(result.ignoredFiles, 2);
});

test('reasons name the family, the description and the file count', () => {
  const result = select(['src/a.ts', 'src/b.ts', 'scripts/ci.js'], config);

  assert.deepEqual(result.checks, ['app', 'tooling']);
  assert.ok(result.checkReasons.includes('app: build, lint, unit (2 files)'));
  assert.ok(result.checkReasons.includes('tooling: repo tooling (1 file)'));
});

test('returns the exact commands to run, in the config order', () => {
  const result = select(['src/a.ts', 'scripts/ci.js'], config);

  assert.deepEqual(result.commands.checks, ['npm run verify', 'npm run test:scripts']);
});
