#!/usr/bin/env node
'use strict';

/**
 * Decides what this diff requires. Two questions, two maps, opposite defaults.
 *
 *   checks  which check families to run (build, lint, unit, whatever you name)
 *   suites  which end-to-end suites the change can actually break
 *
 * The defaults are the whole design, so they are worth stating plainly:
 *
 *   A path no CHECK rule matches selects EVERY family. Nothing re-runs build,
 *   lint or unit after a merge, so a family skipped here is skipped for good.
 *   Silence has to mean "run it".
 *
 *   A path no SUITE rule matches selects EVERY suite, unless the config sets
 *   e2e.unmapped to "none" AND names what runs the full suite after a merge.
 *   Skipping e2e is only safe when something else catches it later, so that has
 *   to be a claim the config makes out loud rather than a default it inherits.
 *
 * Get the mapping wrong and the fix is this config plus a test, never a
 * judgment call at the moment of pushing.
 *
 * Usage:
 *   node scripts/select-checks.js
 *   node scripts/select-checks.js --explain
 *   node scripts/select-checks.js --base main --config ./push.config.json
 *   node scripts/select-checks.js --strict   # exit 1 when any path matched no rule
 */

const { loadConfig, changedFiles } = require('./lib/config');
const { matchesAny } = require('./lib/match');

/** Pure core, so it can be tested without a git repo. */
function select(files, config) {
  const unmappedSuitesRunAll = (config.e2e || {}).unmapped !== 'none';
  const allFamilies = Object.keys(config.checks || {});
  const allSuites = Object.keys(config.suites || {});

  const considered = files.filter((file) => !matchesAny(file, config.ignore));
  const ignored = files.filter((file) => matchesAny(file, config.ignore));

  const checkHits = new Map();
  const suiteHits = new Map();
  const unmapped = [];
  const perFile = [];

  const record = (map, key, file) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(file);
  };

  for (const file of considered) {
    const families = allFamilies.filter((name) =>
      matchesAny(file, config.checks[name].paths)
    );
    const suites = allSuites.filter((name) =>
      matchesAny(file, config.suites[name].paths)
    );

    if (families.length === 0) unmapped.push(file);
    for (const name of families) record(checkHits, name, file);
    for (const name of suites) record(suiteHits, name, file);

    perFile.push({ file, checks: families, suites });
  }

  // An unmapped path pulls in every check family, because nothing re-runs build,
  // lint or unit after a merge: a family skipped here is skipped for good.
  if (unmapped.length > 0) {
    for (const name of allFamilies) record(checkHits, name, unmapped[0]);
  }

  // And, by default, every e2e suite too. Skipping e2e on an unmapped path is
  // only safe when something else runs the full suite after a merge, which is a
  // claim this config has to make explicitly (e2e.unmapped: "none").
  const unmappedSuites = considered.filter((file) => !allSuites.some((name) => matchesAny(file, config.suites[name].paths)));
  if (unmappedSuitesRunAll && unmappedSuites.length > 0) {
    for (const name of allSuites) record(suiteHits, name, unmappedSuites[0]);
  }

  const describe = (map, source, key) => {
    const hits = map.get(key) || [];
    const label = source[key].description || key;
    return `${key}: ${label} (${hits.length} file${hits.length === 1 ? '' : 's'})`;
  };

  const checks = allFamilies.filter((name) => checkHits.has(name));
  const suites = allSuites.filter((name) => suiteHits.has(name));

  const checkReasons = checks.map((name) => describe(checkHits, config.checks, name));
  const reasons = suites.map((name) => describe(suiteHits, config.suites, name));
  if (unmappedSuitesRunAll && unmappedSuites.length > 0 && suites.length > 0) {
    reasons.push(
      `all suites: ${unmappedSuites.length} path(s) match no e2e rule, and e2e.unmapped is "all"`
    );
  }
  if (unmapped.length > 0) {
    checkReasons.push(
      `all families: ${unmapped.length} path(s) match no rule, so nothing can vouch for them (${unmapped
        .slice(0, 3)
        .join(', ')}${unmapped.length > 3 ? ', ...' : ''})`
    );
  }

  return {
    changedFiles: considered.length,
    ignoredFiles: ignored.length,
    checksRequired: checks.length > 0,
    checks,
    checkReasons,
    suites,
    reasons,
    unmappedSuites,
    unmapped,
    commands: {
      checks: checks.map((name) => config.checks[name].command),
      suites: suites.map((name) => config.suites[name].command),
    },
    perFile,
  };
}

function main(argv) {
  const arg = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const config = loadConfig(arg('--config'));
  const base = arg('--base') || config.git.base;
  const files = changedFiles(base, undefined, arg('--ref') || 'HEAD');
  const result = select(files, config);
  const explain = argv.includes('--explain');

  if (explain) {
    for (const row of result.perFile) {
      const checks = row.checks.length ? row.checks.join(', ') : 'no rule (selects all families)';
      const suites = row.suites.length ? row.suites.join(', ') : 'none';
      process.stdout.write(`${row.file}\n  checks: ${checks}\n  suites: ${suites}\n`);
    }
    process.stdout.write('\n');
  }

  const { perFile, ...summary } = result;
  process.stdout.write(`${JSON.stringify({ base, ...summary }, null, 2)}\n`);

  // For CI, where nobody reads JSON. An unmapped path is not a failure of the
  // branch, it is a hole in the map, and it is worth surfacing before the map
  // quietly stops describing the repo.
  if (argv.includes('--strict') && result.unmapped.length > 0) process.exit(1);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { select };
