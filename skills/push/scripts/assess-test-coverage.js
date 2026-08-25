#!/usr/bin/env node
'use strict';

/**
 * Answers the question a green suite cannot: did this branch test what it changed?
 *
 * It reports per AREA, not per file, because that is the granularity a repo's
 * conventions actually hold at. A per-file rule fires on nearly every branch in
 * the parts of a codebase that are covered end-to-end instead of by unit tests,
 * and a rule that fires constantly gets ignored inside a week, taking the
 * signal you wanted with it.
 *
 * It is mechanical on purpose. It can see that an area changed logic and gained
 * no test. It cannot see whether the test is any good. That judgment belongs to
 * the review step, and the two are not substitutes.
 *
 * Usage:
 *   node scripts/assess-test-coverage.js
 *   node scripts/assess-test-coverage.js --base main --strict
 */

const path = require('path');
const { loadConfig, changedFiles } = require('./lib/config');
const { matchesAny } = require('./lib/match');

/** Where a sibling test for this file would go, following the repo's convention. */
function suggestTestPath(file, convention = 'sibling') {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);

  if (convention === '__tests__') return path.join(dir, '__tests__', `${stem}.test${ext}`);
  if (convention === 'parallel-tests-dir') {
    return path.join(dir.replace(/^src\b/, 'tests'), `${stem}.test${ext}`);
  }
  return path.join(dir, `${stem}.test${ext}`);
}

/** Pure core, so it can be tested without a git repo. */
function assess(files, config) {
  const { areas, exempt, testGlobs, logicExtensions } = config.coverage;

  const isTest = (file) => matchesAny(file, testGlobs);
  const isLogic = (file) => logicExtensions.includes(path.extname(file));
  const areaFor = (file) => areas.find((area) => matchesAny(file, area.paths));

  const buckets = new Map();
  const unclaimed = [];

  for (const file of files) {
    if (matchesAny(file, exempt)) continue;
    if (!isTest(file) && !isLogic(file)) continue;

    const area = areaFor(file);
    if (!area) {
      if (isLogic(file) && !isTest(file)) unclaimed.push(file);
      continue;
    }

    if (!buckets.has(area.name)) buckets.set(area.name, { area, source: [], tests: [] });
    const bucket = buckets.get(area.name);
    if (isTest(file)) bucket.tests.push(file);
    else bucket.source.push(file);
  }

  const gaps = [];
  const tested = [];

  for (const { area, source, tests } of buckets.values()) {
    if (source.length === 0) continue;

    if (tests.length > 0) {
      tested.push({ area: area.name, files: source.length, tests: tests.length });
      continue;
    }

    gaps.push({
      area: area.name,
      advisory: Boolean(area.advisory),
      note: area.note,
      files: source,
      suggested: source.map((file) => suggestTestPath(file, area.testConvention)),
    });
  }

  const blockingGaps = gaps.filter((gap) => !gap.advisory);
  const advisoryGaps = gaps.filter((gap) => gap.advisory);

  // Logic no area claims blocks by default. The script cannot vouch for it, and
  // "nobody wrote a rule for this directory" is the case most likely to be new
  // code nobody has thought about.
  if (config.coverage.unclaimedBlocks !== false && unclaimed.length > 0) {
    blockingGaps.push({
      area: '(unclaimed)',
      advisory: false,
      note: 'No coverage area claims these files. Add an area, or add them to coverage.exempt with a reason.',
      files: unclaimed,
      suggested: unclaimed.map((file) => suggestTestPath(file)),
    });
  }

  let verdict = 'tested';
  if (blockingGaps.length > 0) verdict = 'gaps';
  else if (advisoryGaps.length > 0) verdict = 'advisory-only';

  return { verdict, blockingGaps, advisoryGaps, tested, unclaimed };
}

function main(argv) {
  const arg = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const config = loadConfig(arg('--config'));
  const base = arg('--base') || config.git.base;
  const result = assess(changedFiles(base, undefined, arg('--ref') || 'HEAD'), config);

  process.stdout.write(`${JSON.stringify({ base, ...result }, null, 2)}\n`);

  if (argv.includes('--strict') && result.blockingGaps.length > 0) process.exit(1);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { assess, suggestTestPath };
