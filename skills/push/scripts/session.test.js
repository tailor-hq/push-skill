'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { held } = require('./session');

const HOUR = 60 * 60 * 1000;

test('a lock is held until it is released, not until its process exits', () => {
  // `session.js start` exits immediately, so pid liveness would report the lock
  // free a millisecond after it was taken, while the run it guards is still on.
  const now = 1_000_000;

  assert.equal(held({ pid: 999999, startedAt: now }, now), true);
  assert.equal(held({ pid: 999999, startedAt: now - 60_000 }, now), true);
});

test('a lock from a crashed run goes stale rather than blocking forever', () => {
  const now = 1_000_000 + 3 * HOUR;

  assert.equal(held({ pid: 1, startedAt: 1_000_000 }, now), false);
});

test('no lock file means no lock', () => {
  assert.equal(held(null), false);
});
