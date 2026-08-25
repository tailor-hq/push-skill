#!/usr/bin/env node
'use strict';

/**
 * Per-run scratch space, and a per-worktree lock.
 *
 * Fixed filenames like `.tmp/code-review.md` are safe across sequential runs but
 * not across simultaneous ones, and a skill whose whole premise is several
 * agents working at once should not assume it is alone. Two runs in the same
 * worktree would overwrite each other's review files and each embed the other's
 * verdict, which is worse than either failing.
 *
 * State lives under `.git/`, so it never shows up in `git status` and never gets
 * committed by accident. Different worktrees have different `.git` paths, so
 * they run in parallel freely; two runs in ONE worktree is the case that fails.
 *
 * Usage:
 *   node session.js start   # prints the scratch dir, takes the lock
 *   node session.js end     # releases the lock
 *   node session.js dir     # prints the current dir without locking
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** `.git` for this worktree: a directory normally, a file in a linked worktree. */
function gitDir(cwd = process.cwd()) {
  return execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * A lock outlives the process that took it, on purpose. `session.js start` exits
 * immediately, so pid liveness would say "released" a millisecond later while
 * the run it guards is still going. The bound is time, and a crashed run frees
 * it after this long.
 */
const STALE_MS = 2 * 60 * 60 * 1000;

const root = (cwd) => path.join(gitDir(cwd), 'push-skill');
const lockPath = (cwd) => path.join(root(cwd), 'lock.json');

function readLock(cwd) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(cwd), 'utf8'));
  } catch {
    return null;
  }
}

/** A lock is real until it is released, or until it goes stale. */
function held(lock, now = Date.now()) {
  if (!lock) return false;
  return now - lock.startedAt <= STALE_MS;
}

function start(cwd = process.cwd(), now = Date.now()) {
  const existing = readLock(cwd);
  if (held(existing, now)) {
    const age = Math.round((now - existing.startedAt) / 1000);
    throw new Error(
      `Another push is already running in this worktree (pid ${existing.pid}, started ${age}s ago, ${existing.dir}).\n` +
        `Wait for it, or run from a separate worktree. If that process is gone, delete ${lockPath(cwd)}.`
    );
  }

  const dir = path.join(root(cwd), `run-${process.pid}-${now}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockPath(cwd), JSON.stringify({ pid: process.pid, startedAt: now, dir }, null, 2));
  return dir;
}

function end(cwd = process.cwd()) {
  try {
    fs.unlinkSync(lockPath(cwd));
  } catch {
    /* already gone */
  }
}

/** The newest run directory, for a later step that needs the same scratch space. */
function currentDir(cwd = process.cwd()) {
  const lock = readLock(cwd);
  if (lock && lock.dir) return lock.dir;
  throw new Error('No push session is active here. Run `session.js start` first.');
}

if (require.main === module) {
  const [command = 'start'] = process.argv.slice(2);
  try {
    if (command === 'start') process.stdout.write(`${start()}\n`);
    else if (command === 'end') end();
    else if (command === 'dir') process.stdout.write(`${currentDir()}\n`);
    else throw new Error(`Unknown command: ${command}. Use start, end, or dir.`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { start, end, currentDir, held, gitDir };
