#!/usr/bin/env node
'use strict';

/**
 * Writes a starter `push.config.json` by looking at what this repo already has,
 * then tells you what it guessed and what you should check.
 *
 * The guesses are a starting point, not an answer. The two that matter most and
 * that no tool can infer are which coverage areas should BLOCK a push and which
 * are advisory, and which paths can reach which e2e suite. Both are judgment
 * about your codebase, so the file it writes marks them for you to edit.
 *
 * Usage:
 *   node scripts/init-config.js            # write push.config.json
 *   node scripts/init-config.js --force    # overwrite an existing one
 *   node scripts/init-config.js --check    # validate the config you have
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { CONFIG_NAME, loadConfig, validateConfig, configNotes, findPlaceholders, changedFiles, repoRoot } = require('./lib/config');

const UI_HINTS = ['component', 'page', 'view', 'ui', 'screen', 'app'];
const E2E_HINTS = ['e2e', 'cypress', 'integration', 'acceptance'];

const first = (file) => file.split('/')[0];

/**
 * How to spell a sibling script, the way the caller reached this one.
 *
 * The scripts ship with the skill and are normally run from there, so printing
 * `node scripts/x.js` tells a reader to run something that does not exist in
 * their repo.
 */
const invokedFrom = (script) => path.join(path.dirname(process.argv[1] || '.'), script);

/** Which package runner this repo uses, from its lockfile. */
function detectRunner(files) {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  if (files.includes('bun.lockb')) return 'bun run';
  return 'npm run';
}

/** Sibling (`foo.test.ts`), `__tests__/`, or a top-level `tests/` tree? */
function detectTestConvention(files) {
  const counts = { sibling: 0, __tests__: 0, 'parallel-tests-dir': 0 };

  for (const file of files) {
    if (file.includes('/__tests__/')) counts.__tests__ += 1;
    else if (/^tests?\//.test(file)) counts['parallel-tests-dir'] += 1;
    else if (/\.(test|spec)\.[a-z]+$/.test(file)) counts.sibling += 1;
  }

  const [best] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : 'sibling';
}

/** Compose the check command from the scripts that actually exist. */
function detectCheckCommand(pkg, runner) {
  const scripts = (pkg && pkg.scripts) || {};
  const wanted = ['build', 'lint', 'typecheck', 'test'].filter((name) => scripts[name]);

  if (wanted.length > 0) return wanted.map((name) => `${runner} ${name}`).join(' && ');
  if (scripts.test) return `${runner} test`;
  return null;
}

/** Source directories worth treating as areas, most populated first. */
function detectSourceDirs(files) {
  const counts = new Map();

  for (const file of files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|rs|java|kt|cs|php)$/.test(file)) continue;
    if (/\.(test|spec)\./.test(file) || file.includes('/__tests__/')) continue;
    const dir = path.dirname(file);
    const key = dir.split('/').slice(0, 2).join('/');
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const eligible = [...counts.entries()]
    .filter(([dir]) => dir !== '.' && !E2E_HINTS.some((hint) => dir.includes(hint)))
    .sort((a, b) => b[1] - a[1]);

  // Density first, because in a large repo the three-file floor keeps one-off
  // directories out of the map. But a small or new repo has no directory that
  // clears it, and returning nothing there is the worst outcome: the generated
  // config gets no coverage areas and no source paths, so the gate it exists to
  // set up can never fire. Fall back to every directory that holds any logic.
  const dense = eligible.filter(([, count]) => count >= 3);
  return (dense.length > 0 ? dense : eligible).slice(0, 6).map(([dir]) => dir);
}

/** Directories that look like an end-to-end suite. */
function detectE2eDirs(files) {
  const dirs = new Set();
  for (const file of files) {
    const top = first(file);
    if (E2E_HINTS.some((hint) => top === hint || top.startsWith(`${hint}-`))) dirs.add(top);
    if (/^(tests?|spec)\/(e2e|integration)\//.test(file)) dirs.add(file.split('/').slice(0, 2).join('/'));
  }
  return [...dirs];
}

/**
 * A workflow that runs on a schedule, which is the only honest basis for
 * skipping e2e on a branch. Suggested, never assumed: whether it runs the FULL
 * suite is a claim only a human can make.
 */
function detectScheduledWorkflow(files, read) {
  for (const file of files.filter((f) => /^\.github\/workflows\/.+\.ya?ml$/.test(f))) {
    const body = read(file);
    if (body && /\bschedule:/.test(body) && /\bcron:/.test(body)) return file;
  }
  return null;
}

/** Guidelines the reviewers should read, if this repo already writes them down. */
function detectGuidelines(files) {
  const candidates = [
    'CONTRIBUTING.md',
    'CLAUDE.md',
    'AGENTS.md',
    'docs/style-guide.md',
    'docs/security.md',
    'SECURITY.md',
  ];
  return candidates.filter((file) => files.includes(file));
}

/** The whole guess, as a pure function of the repo's file list. */
function detect({ files, pkg, base, readFile = () => null }) {
  const runner = detectRunner(files);
  const checkCommand = detectCheckCommand(pkg, runner);
  const sourceDirs = detectSourceDirs(files);
  const e2eDirs = detectE2eDirs(files);
  const convention = detectTestConvention(files);

  const rootConfigs = ['package.json', 'tsconfig.json', 'go.mod', 'pyproject.toml', 'Cargo.toml'].filter((f) =>
    files.includes(f)
  );

  const config = {
    $comment: `Generated by init-config.js. Every value marked below needs your answer before this is trustworthy.`,
    git: { base, pushRemote: 'origin' },

    // Deliberately not **/*.md: SKILL.md, CLAUDE.md, AGENTS.md and threat models
    // are markdown and they decide behavior. Map those to a check family.
    ignore: ['docs/**', 'LICENSE'],

    checks: {},
    suites: {},

    e2e: (() => {
      const scheduled = detectScheduledWorkflow(files, readFile);
      if (!scheduled) {
        return {
          $comment: 'Set unmapped to "none" only if you also declare mainBranchSafetyNet.',
          unmapped: 'all',
          mainBranchSafetyNet: null,
        };
      }
      return {
        $comment: `${scheduled} runs on a schedule. If it runs the FULL suite against your main branch, set unmapped to "none" and keep the declaration below. If it does not, delete mainBranchSafetyNet and leave unmapped as "all".`,
        unmapped: 'all',
        mainBranchSafetyNet: {
          description: `TODO: confirm ${scheduled} runs the full suite against the main branch, and say what happens when it fails.`,
          workflow: scheduled,
        },
      };
    })(),

    review: {
      guidelines: detectGuidelines(files),
      securitySurfaces: [],
      // null means one model runs both passes. Wire a real second model here:
      // { "command": ["codex", "exec", "--output-last-message", "{outputFile}", "{promptFile}"] }
      secondOpinion: null,
    },

    exercise: { notes: ['TODO: how does an agent drive this app locally? URL, how to sign in, how to watch it work.'] },

    coverage: { areas: [], exempt: ['**/*.d.ts', '**/generated/**'], unclaimedBlocks: true },
  };

  config.checks.app = {
    command: checkCommand || 'TODO: the command that builds, lints and unit-tests this repo',
    description: 'build, lint and unit tests',
    paths: [...sourceDirs.map((dir) => `${dir}/**`), ...rootConfigs].filter(Boolean),
  };

  if (files.some((f) => f.startsWith('scripts/') || f.startsWith('.github/'))) {
    config.checks.tooling = {
      command: 'TODO: the command that tests your own scripts, or delete this family',
      description: "the repo's own tooling",
      paths: ['scripts/**', '.github/**', CONFIG_NAME],
    };
  }

  for (const dir of e2eDirs) {
    config.suites[dir.replace(/\W+/g, '-')] = {
      command: `TODO: the command that runs the ${dir} suite`,
      description: `${dir} suite`,
      // Deliberately narrow. An e2e suite should be selected by the code that
      // feeds the flow it exercises, not by everything in the repo.
      paths: [`${dir}/**`, 'TODO: the source paths whose changes can break this suite'],
    };
  }

  for (const dir of sourceDirs) {
    const advisory = UI_HINTS.some((hint) => dir.toLowerCase().includes(hint));
    config.coverage.areas.push({
      name: dir,
      paths: [`${dir}/**`],
      testConvention: convention,
      ...(advisory
        ? { advisory: true, note: 'TODO: confirm. Guessed advisory because it looks like UI, which is usually covered end to end rather than by unit tests.' }
        : {}),
    });
  }

  return config;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The first base ref that actually resolves here.
 *
 * Returns the ref it verified, never a rewritten one. Verifying a local `main`
 * and then returning `origin/main` produces a base that does not exist, and
 * every diff after it fails, in exactly the repos that have no remote yet.
 */
function detectBase(root) {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root, stdio: 'pipe' });
      return ref;
    } catch {
      /* try the next one */
    }
  }
  return 'origin/main';
}

function runCheck(root) {
  const config = loadConfig();
  const problems = validateConfig(config);

  // A TODO is not a note to self here. It is a string that would be handed to a
  // shell, or a path glob that matches nothing.
  // Name them. "3 placeholders remain" sends a reader hunting through JSON.
  for (const where of findPlaceholders(config)) {
    problems.push(`${where}: still a TODO placeholder, and it would be used verbatim`);
  }

  if (problems.length > 0) {
    process.stdout.write(`${problems.length} thing(s) to fix in ${CONFIG_NAME}:\n`);
    for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  } else {
    process.stdout.write(`${CONFIG_NAME} looks usable.\n`);
  }

  const notes = configNotes(config);
  for (const note of notes) process.stdout.write(`  note: ${note}\n`);

  // Dry-run against the current branch, which is the only way to see whether
  // the maps say what you meant.
  try {
    const { select } = require('./select-checks');
    const files = changedFiles(config.git.base, root);
    const result = select(files, config);
    process.stdout.write(
      `\nAgainst this branch (${files.length} changed file(s) vs ${config.base}):\n` +
        `  checks: ${result.checks.join(', ') || 'none'}\n` +
        `  suites: ${result.suites.join(', ') || 'none'}\n` +
        `  unmapped: ${result.unmapped.length}\n`
    );
  } catch {
    process.stdout.write(`\nCould not compare against ${config.git.base} from here.\n`);
  }

  return problems.length === 0 ? 0 : 1;
}

function main(argv) {
  const root = repoRoot();

  if (argv.includes('--check')) return runCheck(root);

  const target = path.join(root, CONFIG_NAME);
  if (fs.existsSync(target) && !argv.includes('--force')) {
    process.stdout.write(`${target} already exists. Re-run with --force to overwrite, or --check to validate it.\n`);
    return 1;
  }

  const files = trackedFiles(root);
  const pkgPath = path.join(root, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : null;

  const config = detect({
    files,
    pkg,
    base: detectBase(root),
    readFile: (file) => {
      try {
        return fs.readFileSync(path.join(root, file), 'utf8');
      } catch {
        return null;
      }
    },
  });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);

  const todos = findPlaceholders(config).length;
  process.stdout.write(
    `Wrote ${target}\n\n` +
      `Guessed: ${Object.keys(config.checks).length} check famil(ies), ` +
      `${Object.keys(config.suites).length} e2e suite(s), ` +
      `${config.coverage.areas.length} coverage area(s).\n` +
      (todos ? `${todos} TODO placeholder(s) need your answer.\n` : '') +
      `\nNext:\n` +
      `  1. Edit the TODOs, and check which coverage areas should block versus advise.\n` +
      `  2. node ${invokedFrom('init-config.js')} --check\n` +
      `  3. node ${invokedFrom('select-checks.js')} --explain\n`
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  detect,
  detectTestConvention,
  detectSourceDirs,
  detectE2eDirs,
  detectCheckCommand,
  detectRunner,
  detectScheduledWorkflow,
};
