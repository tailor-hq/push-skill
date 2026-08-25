#!/usr/bin/env node
'use strict';

/**
 * Runs the configured second-model reviewer, and never fails the push.
 *
 * The config declares an argv command; something has to actually run it, write
 * the prompt, enforce a timeout, and decide what happens when the binary is
 * missing or the auth expired. Leaving that to the agent means it gets
 * improvised, and it gets improvised worst exactly on the failure paths.
 *
 * Two rules the whole design turns on:
 *
 *   It always exits 0. An advisory reviewer that can block a push is not
 *   advisory, and a second opinion that breaks the pipeline when a personal CLI
 *   is not installed would be turned off within a week.
 *
 *   Gate on `status` in the output file, never on the exit code. A skip and a
 *   clean review must be distinguishable, or "nothing found" and "nothing ran"
 *   look identical.
 *
 * Usage:
 *   node second-opinion.js --prompt <file> --out <file> [--config <file>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadConfig, hasSecondModel } = require('./lib/config');

const DEFAULT_TIMEOUT_MS = 7 * 60 * 1000;

/** Fill {promptFile} / {outputFile} as whole argv elements, never by string splicing. */
function buildArgv(command, { promptFile, outputFile }) {
  return command.map((part) =>
    part.replace('{promptFile}', promptFile).replace('{outputFile}', outputFile)
  );
}

function write(outputFile, payload) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

/**
 * @returns {{status: 'ok'|'skipped', reason?: string, hint?: string, output?: string}}
 */
function run(config, { promptFile, outputFile, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  if (!hasSecondModel(config)) {
    return write(outputFile, {
      status: 'skipped',
      reason: 'review.secondOpinion is not configured',
      hint:
        'One model is running both passes, which is one reviewer with one blind spot. ' +
        'Wire a different model with review.secondOpinion.command, e.g. ' +
        '["codex", "exec", "--output-last-message", "{outputFile}", "{promptFile}"]. ' +
        'Say in the report that only one model reviewed this branch.',
    });
  }

  const [binary, ...rest] = buildArgv(config.review.secondOpinion.command, { promptFile, outputFile });

  // Clear the output first, so "the file exists afterwards" can only mean this
  // run wrote it. Without this, a second invocation reads the previous run's
  // file and reports it as a fresh review, which is the stale-artifact failure
  // the skill spends a whole step preventing.
  try {
    fs.unlinkSync(outputFile);
  } catch {
    /* nothing to clear */
  }

  // No shell. The prompt path and anything the model wrote are data, and a
  // shell would make their quotes and semicolons into syntax.
  const result = spawn(binary, rest, {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error && result.error.code === 'ENOENT') {
    return write(outputFile, {
      status: 'skipped',
      reason: `${binary} is not installed on this machine`,
      hint: `Install it, or clear review.secondOpinion to stop expecting it.`,
    });
  }

  if (result.error && (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM')) {
    return write(outputFile, {
      status: 'skipped',
      reason: `${binary} did not finish within ${Math.round(timeoutMs / 1000)}s`,
      hint: 'A hung reviewer must not hold a push. Raise the timeout if the branch is large.',
    });
  }

  if (result.error) {
    return write(outputFile, { status: 'skipped', reason: `${binary} failed to start: ${result.error.message}` });
  }

  if (result.status !== 0) {
    return write(outputFile, {
      status: 'skipped',
      reason: `${binary} exited ${result.status}`,
      hint: (result.stderr || '').trim().slice(0, 500) || undefined,
    });
  }

  // The command may write the file itself (that is what {outputFile} is for).
  // If it did, keep what it wrote and only stamp the status onto it.
  let existing = null;
  try {
    existing = fs.readFileSync(outputFile, 'utf8');
  } catch {
    /* the command wrote nothing */
  }

  const output = (existing || result.stdout || '').trim();

  if (!output) {
    return write(outputFile, { status: 'skipped', reason: `${binary} produced no output` });
  }

  return write(outputFile, { status: 'ok', command: binary, output });
}

function main(argv) {
  const arg = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  const promptFile = arg('--prompt');
  const outputFile = arg('--out');

  if (!promptFile || !outputFile) {
    process.stderr.write('Usage: second-opinion.js --prompt <file> --out <file>\n');
    return 2;
  }

  let config;
  try {
    config = loadConfig(arg('--config'));
  } catch (error) {
    write(outputFile, { status: 'skipped', reason: error.message.split('\n')[0] });
    process.stdout.write('skipped\n');
    return 0;
  }

  const timeout = arg('--timeout-ms');
  const result = run(config, {
    promptFile,
    outputFile,
    timeoutMs: timeout ? Number(timeout) : DEFAULT_TIMEOUT_MS,
  });

  process.stdout.write(`${result.status}${result.reason ? `: ${result.reason}` : ''}\n`);
  return 0; // always. See the header.
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { run, buildArgv, DEFAULT_TIMEOUT_MS };
