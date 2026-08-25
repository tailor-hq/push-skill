'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONFIG_NAME = 'push.config.json';

/** Repo root, so the config is found from any working directory. */
function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return cwd;
  }
}

const DEFAULTS = {
  git: {
    // What everything is compared against, and where pushes go. They differ on
    // a fork: base is upstream/main, pushes go to origin.
    base: 'origin/main',
    pushRemote: 'origin',
  },

  // Paths that select nothing at all. Deliberately does NOT include **/*.md:
  // SKILL.md, CLAUDE.md, AGENTS.md, threat models and runbooks are all markdown
  // and all load-bearing. Map the prose that decides behavior to a check family
  // instead of ignoring the whole extension.
  ignore: ['docs/**', 'LICENSE'],

  checks: {},
  suites: {},

  e2e: {
    // What a path no suite rule matches selects. "all" is the safe default,
    // because it assumes nothing about what runs after a merge.
    unmapped: 'all',
    // Required to set unmapped: "none" or to use the no-e2e argument. Naming
    // the safety net is what makes skipping e2e a decision instead of a hope.
    mainBranchSafetyNet: null,
  },

  review: {
    // Files the reviewers must read first. Your conventions live here, not in
    // SKILL.md, so adopting one is an edit to your repo rather than a fork.
    guidelines: [],
    // Extra security surfaces appended to the Pass 0 checklist, in your words.
    securitySurfaces: [],
    // null  => one model runs both passes, and the report must say so.
    // object => { command: [argv...], required: bool } for a real second model.
    secondOpinion: null,
  },

  exercise: { notes: [] },

  pr: {
    enabled: true,
    // argv arrays, run without a shell. A generated PR title containing a quote
    // or a backtick is data, not syntax.
    createCommand: ['gh', 'pr', 'create', '--title', '{title}', '--body-file', '{body}'],
    updateCommand: ['gh', 'pr', 'edit', '--title', '{title}', '--body-file', '{body}'],
  },

  coverage: {
    areas: [],
    exempt: [],
    // A changed source file no area claims is a gap by default: that is exactly
    // the case where nothing can vouch for it.
    unclaimedBlocks: true,
    testGlobs: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test_*.py', '**/*_test.go'],
    logicExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rb', '.rs', '.java', '.kt', '.cs', '.php'],
  },
};

const SECTIONS = ['git', 'e2e', 'review', 'exercise', 'pr', 'coverage'];

/** Merge one level deep, so a partial section keeps the other defaults. */
function withDefaults(parsed) {
  const merged = { ...DEFAULTS, ...parsed };
  for (const key of SECTIONS) merged[key] = { ...DEFAULTS[key], ...(parsed[key] || {}) };

  // `base` used to live at the top level. Keep old configs working.
  if (parsed.base && !(parsed.git && parsed.git.base)) merged.git.base = parsed.base;
  merged.base = merged.git.base;

  return merged;
}

/** Read push.config.json, filling in defaults. Throws with a usable message. */
function loadConfig(explicitPath) {
  const file = explicitPath || path.join(repoRoot(), CONFIG_NAME);

  if (!fs.existsSync(file)) {
    throw new Error(
      `No ${CONFIG_NAME} found at ${file}.\n` +
        `Run: node "\${CLAUDE_SKILL_DIR}/scripts/init-config.js"\n` +
        `It inspects this repo and writes a starter config you can edit.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }

  return withDefaults(parsed);
}

/** True when this config has declared what catches the e2e it skips. */
const hasSafetyNet = (config) => {
  const net = config.e2e.mainBranchSafetyNet;
  return Boolean(net && typeof net === 'object' && net.description);
};

/** True when a real second model is wired up, rather than a second pass of the first. */
const hasSecondModel = (config) => {
  const second = config.review.secondOpinion;
  return Boolean(second && Array.isArray(second.command) && second.command.length > 0);
};

/**
 * Problems worth telling a human about, in the order they will hit them.
 * Returns [] for a usable config. Never throws.
 */
function validateConfig(config, { exists = (p) => fs.existsSync(p) } = {}) {
  const problems = [];

  if (Object.keys(config.checks).length === 0) {
    problems.push('checks: no check families defined, so nothing would ever run. Add at least one.');
  }

  for (const [name, family] of Object.entries(config.checks)) {
    if (!family.command) problems.push(`checks.${name}: no command`);
    if (!family.paths || family.paths.length === 0) problems.push(`checks.${name}: no paths, so it can never be selected`);
  }

  for (const [name, suite] of Object.entries(config.suites)) {
    if (!suite.command) problems.push(`suites.${name}: no command`);
    if (!suite.paths || suite.paths.length === 0) problems.push(`suites.${name}: no paths, so it can never be selected`);
  }

  for (const area of config.coverage.areas) {
    if (!area.name || !area.paths || area.paths.length === 0) {
      problems.push('coverage.areas: every area needs a name and at least one path');
    }
  }

  if (config.coverage.areas.length === 0) {
    problems.push('coverage.areas: empty, so the test-coverage gate can never fire. Name the areas you expect tests in.');
  }

  for (const file of config.review.guidelines) {
    if (!exists(file)) problems.push(`review.guidelines: ${file} does not exist, so the reviewers cannot read it`);
  }

  if (!['all', 'none'].includes(config.e2e.unmapped)) {
    problems.push(`e2e.unmapped: must be "all" or "none", got ${JSON.stringify(config.e2e.unmapped)}`);
  }

  // The whole argument for skipping e2e on a branch is that something else runs
  // it later. A config that skips without naming that something is a hope.
  if (config.e2e.unmapped === 'none' && !hasSafetyNet(config)) {
    problems.push(
      'e2e.unmapped is "none", but e2e.mainBranchSafetyNet is not declared. ' +
        'Name what runs the full suite after a merge (a description, and ideally the workflow file), or set unmapped to "all".'
    );
  }

  const second = config.review.secondOpinion;
  if (second && !Array.isArray(second.command)) {
    problems.push('review.secondOpinion.command: must be an argv array, e.g. ["codex", "exec", "{promptFile}"]');
  }

  return problems;
}

/** Notes that are true but not failures. Printed alongside problems. */
function configNotes(config) {
  const notes = [];

  if (!hasSecondModel(config)) {
    notes.push(
      'review.secondOpinion is not configured: one model will run both passes. ' +
        'That is one reviewer with one blind spot, and the push report must say so.'
    );
  }

  if (config.e2e.unmapped === 'all' && Object.keys(config.suites).length === 0) {
    notes.push('No e2e suites are defined, so nothing e2e can be selected regardless of e2e.unmapped.');
  }

  return notes;
}

/**
 * Files changed on this branch, against the merge base.
 *
 * Three dots, not two: `base...HEAD` asks what this branch changed, which is
 * not what `base..HEAD` answers once the base has moved on.
 */
function changedFiles(base, cwd = repoRoot(), ref = 'HEAD') {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...${ref}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Placeholder count, ignoring `$comment` fields.
 *
 * Comments are guidance about the placeholders and legitimately mention them.
 * Counting them made the generated file's own header ("Edit the TODOs...") an
 * unfixable finding, so `--check` could never pass for anyone.
 */
function findPlaceholders(value, at = '') {
  if (typeof value === 'string') return value.includes('TODO') ? [at || '(root)'] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => findPlaceholders(item, `${at}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([key]) => key !== '$comment')
      .flatMap(([key, item]) => findPlaceholders(item, at ? `${at}.${key}` : key));
  }
  return [];
}

const countPlaceholders = (value) => findPlaceholders(value).length;

module.exports = {
  countPlaceholders,
  findPlaceholders,
  CONFIG_NAME,
  DEFAULTS,
  loadConfig,
  withDefaults,
  validateConfig,
  configNotes,
  hasSafetyNet,
  hasSecondModel,
  changedFiles,
  repoRoot,
};
