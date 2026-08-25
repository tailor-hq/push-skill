'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { withDefaults, validateConfig, configNotes, hasSecondModel, DEFAULTS } = require('./lib/config');
const { detect, detectTestConvention, detectSourceDirs, detectE2eDirs, detectCheckCommand, detectRunner } = require('./init-config');

const usable = () =>
  withDefaults({
    checks: { app: { command: 'npm test', paths: ['src/**'] } },
    coverage: { areas: [{ name: 'src', paths: ['src/**'] }] },
  });

test('a partial section keeps the rest of its defaults', () => {
  // Someone setting one review key should not silently lose the others.
  const config = withDefaults({ review: { securitySurfaces: ['our auth middleware'] } });

  assert.deepEqual(config.review.securitySurfaces, ['our auth middleware']);
  assert.deepEqual(config.review.guidelines, [], 'the other review keys survive');
  assert.equal(config.e2e.unmapped, 'all', 'and so do the other sections');
});

test('a config written before git.base moved still works', () => {
  const legacy = withDefaults({ base: 'origin/trunk' });

  assert.equal(legacy.git.base, 'origin/trunk');
  assert.equal(legacy.base, 'origin/trunk', 'the old top-level key stays readable');
});

test('a usable config reports no problems', () => {
  assert.deepEqual(validateConfig(usable(), { exists: () => true }), []);
});

test('a family with no paths is reported, since it can never be selected', () => {
  const config = withDefaults({
    checks: { app: { command: 'npm test', paths: [] } },
    coverage: { areas: [{ name: 'src', paths: ['src/**'] }] },
  });

  assert.match(validateConfig(config, { exists: () => true }).join('\n'), /can never be selected/);
});

test('no coverage areas is reported, since the gate could never fire', () => {
  const config = withDefaults({ checks: { app: { command: 'npm test', paths: ['src/**'] } } });

  assert.match(validateConfig(config, { exists: () => true }).join('\n'), /coverage\.areas: empty/);
});

test('a guideline path that does not exist is reported', () => {
  // Silently unreadable guidelines are worse than none: the reviews look
  // configured and apply nothing.
  const config = withDefaults({
    checks: { app: { command: 'npm test', paths: ['src/**'] } },
    coverage: { areas: [{ name: 'src', paths: ['src/**'] }] },
    review: { guidelines: ['docs/nope.md'] },
  });

  assert.match(validateConfig(config, { exists: () => false }).join('\n'), /docs\/nope\.md does not exist/);
});

test('the runner comes from the lockfile', () => {
  assert.equal(detectRunner(['pnpm-lock.yaml']), 'pnpm');
  assert.equal(detectRunner(['yarn.lock']), 'yarn');
  assert.equal(detectRunner(['package-lock.json']), 'npm run');
});

test('the check command is composed from scripts that exist', () => {
  const pkg = { scripts: { build: 'tsc', test: 'jest' } };

  assert.equal(detectCheckCommand(pkg, 'npm run'), 'npm run build && npm run test');
  assert.equal(detectCheckCommand({ scripts: {} }, 'npm run'), null);
});

test('the test convention is whichever one the repo actually uses', () => {
  assert.equal(detectTestConvention(['src/a.test.ts', 'src/b.test.ts']), 'sibling');
  assert.equal(detectTestConvention(['src/__tests__/a.ts', 'src/__tests__/b.ts']), '__tests__');
  assert.equal(detectTestConvention(['tests/a.test.ts', 'tests/b.test.ts']), 'parallel-tests-dir');
  assert.equal(detectTestConvention(['README.md']), 'sibling', 'an empty repo still needs an answer');
});

test('source directories exclude tests and e2e trees', () => {
  const files = [
    'src/services/a.ts', 'src/services/b.ts', 'src/services/c.ts',
    'src/services/a.test.ts',
    'e2e/one.spec.ts', 'e2e/two.spec.ts', 'e2e/three.spec.ts',
  ];

  assert.deepEqual(detectSourceDirs(files), ['src/services']);
  assert.deepEqual(detectE2eDirs(files), ['e2e']);
});

test('the generated config marks the judgment calls instead of guessing them', () => {
  // Which areas block and which paths reach a suite are decisions about a
  // codebase. Guessing them silently is how a config gets trusted wrongly.
  const config = detect({
    files: [
      'package.json', 'CONTRIBUTING.md',
      'src/services/a.ts', 'src/services/b.ts', 'src/services/c.ts',
      'src/components/A.tsx', 'src/components/B.tsx', 'src/components/C.tsx',
      'e2e/checkout.spec.ts', 'e2e/auth.spec.ts', 'e2e/home.spec.ts',
    ],
    pkg: { scripts: { build: 'tsc', lint: 'eslint .', test: 'jest' } },
    base: 'origin/main',
  });

  assert.equal(config.checks.app.command, 'npm run build && npm run lint && npm run test');
  assert.deepEqual(config.review.guidelines, ['CONTRIBUTING.md']);

  const components = config.coverage.areas.find((area) => area.name === 'src/components');
  assert.equal(components.advisory, true, 'UI is guessed advisory');
  assert.match(components.note, /TODO/, 'and the guess is marked for a human');

  assert.match(JSON.stringify(config.suites), /TODO/, 'suite paths are never guessed silently');
});

test('e2e.unmapped "none" is refused unless the safety net is declared', () => {
  // Skipping e2e is only safe when something else runs it after a merge. That
  // has to be a claim the config makes, not one the default assumes.
  const bare = withDefaults({
    checks: { app: { command: 'npm test', paths: ['src/**'] } },
    coverage: { areas: [{ name: 'src', paths: ['src/**'] }] },
    e2e: { unmapped: 'none' },
  });

  assert.match(validateConfig(bare, { exists: () => true }).join('\n'), /mainBranchSafetyNet is not declared/);

  const declared = withDefaults({
    ...bare,
    e2e: { unmapped: 'none', mainBranchSafetyNet: { description: 'Full suite on every main commit' } },
  });

  assert.deepEqual(validateConfig(declared, { exists: () => true }), []);
});

test('the default is the safe one', () => {
  assert.equal(DEFAULTS.e2e.unmapped, 'all');
  assert.equal(DEFAULTS.coverage.unclaimedBlocks, true);
  assert.equal(DEFAULTS.review.secondOpinion, null);
});

test('no second model is a note, not a failure, and it is always said out loud', () => {
  const config = usable();

  assert.deepEqual(validateConfig(config, { exists: () => true }), []);
  assert.match(configNotes(config).join('\n'), /one model will run both passes/);
  assert.equal(hasSecondModel(config), false);

  const wired = withDefaults({ ...config, review: { secondOpinion: { command: ['codex', 'exec'] } } });
  assert.equal(hasSecondModel(wired), true);
  assert.equal(configNotes(wired).join('\n').includes('both passes'), false);
});

test('PR commands are argv arrays, never shell strings', () => {
  // A generated PR title is model output full of quotes and backticks. As an
  // argv element it is data; interpolated into a shell line it is syntax.
  assert.ok(Array.isArray(DEFAULTS.pr.createCommand));
  assert.ok(DEFAULTS.pr.createCommand.includes('{title}'));
});

test('markdown is not ignored wholesale', () => {
  // SKILL.md, CLAUDE.md, AGENTS.md and threat models are markdown, and they
  // decide behavior. Ignoring **/*.md would exempt this skill's own rules.
  assert.ok(!DEFAULTS.ignore.includes('**/*.md'));
});

test('a scheduled workflow is surfaced, never assumed to be the safety net', () => {
  // Only a human can say whether that cron runs the FULL suite, so the guess
  // arrives as a TODO with unmapped still on the safe default.
  const { detectScheduledWorkflow } = require('./init-config');
  const files = ['.github/workflows/e2e.yml', '.github/workflows/test.yml'];
  const bodies = {
    '.github/workflows/e2e.yml': 'on:\n  schedule:\n    - cron: "0 * * * *"\n',
    '.github/workflows/test.yml': 'on:\n  push:\n',
  };

  assert.equal(detectScheduledWorkflow(files, (f) => bodies[f]), '.github/workflows/e2e.yml');

  const config = detect({
    files: [...files, 'src/a.ts', 'src/b.ts', 'src/c.ts'],
    pkg: { scripts: { test: 'jest' } },
    base: 'origin/main',
    readFile: (f) => bodies[f],
  });

  assert.equal(config.e2e.unmapped, 'all', 'still the safe default until a human confirms');
  assert.equal(config.e2e.mainBranchSafetyNet.workflow, '.github/workflows/e2e.yml');
  assert.match(config.e2e.mainBranchSafetyNet.description, /TODO/);
});

test('a small repo still gets coverage areas and source paths', () => {
  // Found by running init-config on a fresh project: the three-file density
  // floor matched nothing, so the generated config had no areas and no source
  // paths, which makes the gate it exists to set up inert.
  const config = detect({
    files: ['package.json', 'src/services/billing.ts', 'src/components/Cart.tsx', 'e2e/checkout.spec.ts'],
    pkg: { scripts: { test: 'jest' } },
    base: 'origin/main',
  });

  assert.ok(config.coverage.areas.length > 0, 'a one-file-per-directory repo still gets areas');
  assert.ok(config.checks.app.paths.some((p) => p.startsWith('src/')), 'and the checks cover its source');
});

test('guidance about placeholders is not itself a placeholder', () => {
  // The generated header used to read "Edit the TODOs before trusting it",
  // which the scan counted, so --check could never pass for anybody.
  const { countPlaceholders } = require('./lib/config');

  assert.equal(countPlaceholders({ $comment: 'Answer every TODO below', value: 'fine' }), 0);
  assert.equal(countPlaceholders({ command: 'TODO: the real command' }), 1);
  assert.equal(countPlaceholders({ nested: { paths: ['src/**', 'TODO: more'] } }), 1);

  const { findPlaceholders } = require('./lib/config');
  assert.deepEqual(findPlaceholders({ suites: { e2e: { command: 'TODO: run it' } } }), ['suites.e2e.command']);
});
