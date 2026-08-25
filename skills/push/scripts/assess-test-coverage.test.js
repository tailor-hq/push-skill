'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { assess, suggestTestPath } = require('./assess-test-coverage');
const { DEFAULTS } = require('./lib/config');

const config = {
  coverage: {
    ...DEFAULTS.coverage,
    exempt: ['**/*.d.ts', 'src/generated/**'],
    areas: [
      { name: 'src/services', paths: ['src/services/**'] },
      { name: 'src/components', paths: ['src/components/**'], advisory: true, note: 'covered by e2e' },
    ],
  },
};

test('an area that changed logic and gained a test is tested', () => {
  const result = assess(['src/services/billing.ts', 'src/services/billing.test.ts'], config);

  assert.equal(result.verdict, 'tested');
  assert.deepEqual(result.blockingGaps, []);
});

test('an area that changed logic and gained no test is a blocking gap', () => {
  const result = assess(['src/services/billing.ts'], config);

  assert.equal(result.verdict, 'gaps');
  assert.equal(result.blockingGaps.length, 1);
  assert.deepEqual(result.blockingGaps[0].suggested, ['src/services/billing.test.ts']);
});

test('an advisory area never blocks, but is still reported', () => {
  const result = assess(['src/components/Cart.tsx'], config);

  assert.equal(result.verdict, 'advisory-only');
  assert.deepEqual(result.blockingGaps, []);
  assert.equal(result.advisoryGaps[0].note, 'covered by e2e');
});

test('a blocking gap outranks an advisory one', () => {
  const result = assess(['src/components/Cart.tsx', 'src/services/billing.ts'], config);

  assert.equal(result.verdict, 'gaps');
});

test('exempt paths are not gaps', () => {
  const result = assess(['src/services/types.d.ts', 'src/generated/schema.ts'], config);

  assert.equal(result.verdict, 'tested');
});

test('logic no area claims blocks, because nothing can vouch for it', () => {
  const result = assess(['workers/queue.ts'], config);

  assert.deepEqual(result.unclaimed, ['workers/queue.ts']);
  assert.equal(result.verdict, 'gaps');
  assert.equal(result.blockingGaps[0].area, '(unclaimed)');
});

test('unclaimed can be made non-blocking, but only in the config', () => {
  const lenient = { coverage: { ...config.coverage, unclaimedBlocks: false } };
  const result = assess(['workers/queue.ts'], lenient);

  assert.deepEqual(result.unclaimed, ['workers/queue.ts']);
  assert.equal(result.verdict, 'tested');
});

test('non-logic files never create a gap on their own', () => {
  const result = assess(['src/services/config.json'], config);

  assert.equal(result.verdict, 'tested');
});

test('suggested paths follow the configured convention', () => {
  assert.equal(suggestTestPath('src/a/b.ts'), 'src/a/b.test.ts');
  assert.equal(suggestTestPath('src/a/b.ts', '__tests__'), 'src/a/__tests__/b.test.ts');
  assert.equal(suggestTestPath('src/a/b.ts', 'parallel-tests-dir'), 'tests/a/b.test.ts');
});
