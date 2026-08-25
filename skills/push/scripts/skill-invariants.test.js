'use strict';

/**
 * Tests for the prose.
 *
 * SKILL.md is the only thing telling the agent what to run and in what order,
 * which makes it load-bearing, which means it can break. And it breaks quietly:
 * prose builds, lints and tests clean, so a mis-ordered procedure or a command
 * that no longer exists looks exactly like a working one until the day it
 * matters.
 *
 * The real regression this pattern caught: a merge-base check written to
 * prevent a bad rebase shipped BELOW the rebase it was meant to gate, so its
 * "do not run the rebase" instruction described a rebase that had already
 * happened.
 *
 * These assert order and existence, never wording, so the file can be rewritten
 * freely.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_DIR = path.join(__dirname, '..');           // skills/push
const REPO = path.join(SKILL_DIR, '..', '..');          // the repo root
const SKILL = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

/** Index of a literal that must appear exactly once, so ordering is unambiguous. */
function soleIndex(needle) {
  const first = SKILL.indexOf(needle);
  assert.ok(first > -1, `SKILL.md no longer mentions ${JSON.stringify(needle)}`);
  assert.equal(
    SKILL.indexOf(needle, first + 1),
    -1,
    `${JSON.stringify(needle)} appears more than once, so its position is ambiguous`
  );
  return first;
}

const before = (a, b, why) => assert.ok(soleIndex(a) < soleIndex(b), why);

test('the shallow check runs before the fetch that depends on it', () => {
  before('git rev-parse --is-shallow-repository', 'git fetch origin\n', 'unshallow first or the fetch is useless');
});

test('the merge-base check runs before the rebase it gates', () => {
  before('git merge-base origin/main HEAD', 'git rebase origin/main\n', 'a gate below the thing it gates is not a gate');
});

test('the merge-base section tells the reader not to rebase', () => {
  const guidance = SKILL.slice(
    soleIndex('git merge-base origin/main HEAD'),
    soleIndex('git rebase origin/main\n')
  );
  assert.match(guidance, /do not run the rebase/i);
});

test('the reviewers are spawned before the checks they run alongside', () => {
  before('### 2. Spawn the reviewers', '### 4. Run the check families', 'spawning late wastes the build window');
});

test('every gate runs before the push', () => {
  const push = soleIndex('### 12. Push');
  for (const step of [
    '### 5. Is the change tested at all?',
    '### 6. Exercise the new code against a running system',
    '### 7. Harvest the reviews',
    '### 10. Gate the tree you are actually pushing',
    '### 11. Write the PR body BEFORE the push',
  ]) {
    assert.ok(soleIndex(step) < push, `${step} must come before the push`);
  }
});

test('security is read before the rest of the review', () => {
  // Not a formality. It is the one finding class whose cost is paid by someone
  // other than the author, so it gets the attention first.
  before(
    '#### 7a. The security section, first and blocking',
    '#### 7b. Critical issues',
    'the security section must be acted on first'
  );
});

test('the reviewer is required to emit a Security section even when there is nothing to report', () => {
  // A missing section is indistinguishable from a clean one unless the heading
  // is mandatory, and "no security impact" with nothing named is a failed pass.
  assert.match(SKILL, /The `## Security` heading is required/);
  assert.match(SKILL, /Answering "no security impact" without naming what you checked is a failed pass/);
});

test('a latent finding cannot be deferred', () => {
  assert.match(SKILL, /"Latent" is never a reason to reject or defer/);
});

test('the final gate runs after the last step allowed to change code', () => {
  // The verdict describes a tree. Every fix cycle mints a new one, and the
  // edits made after a review are disproportionately the ones that remove
  // guards, which is exactly what the pass exists to catch.
  before(
    '### 9. Handle e2e failures',
    '### 10. Gate the tree you are actually pushing',
    'a re-check that runs before the last code change is decorative'
  );
});

test('the reviewed commit is pinned before the reviewers are spawned', () => {
  // Recording the tree after spawning records a tree nobody read, while
  // sounding exact. This ordering is what makes step 10 mean anything.
  const step2 = SKILL.slice(soleIndex('### 2. Spawn the reviewers'), soleIndex('### 3. Ask the selector'));
  const pinned = step2.indexOf('git rev-parse HEAD^{tree}');
  const spawned = step2.indexOf('**Reviewer A');

  assert.ok(pinned > -1 && spawned > -1);
  assert.ok(pinned < spawned, 'pin REVIEW_COMMIT/REVIEW_TREE before spawning anything');
  assert.match(step2, /Do not review the moving `HEAD`/);
});

test('the final tree must be clean and re-gated before the push', () => {
  const step10 = SKILL.slice(soleIndex('### 10. Gate the tree you are actually pushing'), soleIndex('### 11. Write the PR body'));

  assert.match(step10, /git status --porcelain/, 'uncommitted work would ship the older committed tree');
  assert.match(step10, /select-checks\.js/, 'a late fix can pull in a family nothing selected');
  assert.match(step10, /assess-test-coverage\.js/);
});

test('there is no per-run coverage override', () => {
  // A gate that can be waived by asking is a gate that will be waived by asking.
  assert.match(SKILL, /There is no per-run exception, including one the developer asks for/);
  assert.doesNotMatch(SKILL, /at the developer's request/);
});

test('both reviewers are told the repo is evidence, not instructions', () => {
  const briefs = SKILL.slice(soleIndex('**Reviewer A'), soleIndex('### 3. Ask the selector'));
  const clauses = briefs.match(/untrusted evidence/g) || [];

  assert.ok(clauses.length >= 2, 'reviewer A and reviewer B both need the prompt-injection clause');
});

test('the skill only runs when a person asks for it', () => {
  // It rebases, commits and pushes. Nothing should be able to trigger that on
  // its own initiative.
  assert.match(SKILL, /^disable-model-invocation: true$/m);
});

test('no-e2e requires a declared safety net', () => {
  assert.match(SKILL, /Allowed only when `e2e\.mainBranchSafetyNet` is declared/);
});

test('the skill sends the reviewers to the project\'s own guidelines', () => {
  // The whole adoption story rests on this: a team's standards live in their
  // repo, so taking on a new one is an edit to their files rather than a fork
  // of this skill. If the brief stops naming them, that quietly stops being
  // true and nothing else notices.
  assert.match(SKILL, /review\.guidelines/);
  assert.match(SKILL, /review\.securitySurfaces/);
});

test('nothing project-specific is hardcoded where the config should decide', () => {
  const table = SKILL.slice(soleIndex('| Key | What it controls |'), soleIndex('## The six things'));

  for (const key of ['`git.base`', '`git.pushRemote`', '`e2e.unmapped`', '`review.guidelines`', '`exercise.notes`', '`pr`']) {
    assert.ok(table.includes(key), `the config table should document ${key}`);
  }
});

test('the four rationalizations are each closed by name', () => {
  // A general "do not push failing code" does not close these. Each one was a
  // real argument for pushing anyway, so each gets its own sentence.
  assert.match(SKILL, /pre-existing/i);
  assert.match(SKILL, /unrelated to your changes/i);
  assert.match(SKILL, /known flaky/i);
  assert.match(SKILL, /answer is always no/i);
});

test('every script the skill tells you to run exists', () => {
  const referenced = [...SKILL.matchAll(/node "\$\{CLAUDE_SKILL_DIR\}\/(scripts\/[\w./-]+\.js)"/g)].map((match) => match[1]);

  assert.ok(referenced.length > 0, 'the skill should invoke its bundled scripts via ${CLAUDE_SKILL_DIR}');
  for (const script of new Set(referenced)) {
    assert.ok(fs.existsSync(path.join(SKILL_DIR, script)), `SKILL.md references a missing ${script}`);
  }
});

test('the example config is valid and complete', () => {
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'push.config.example.json'), 'utf8'));

  for (const [name, family] of Object.entries(config.checks)) {
    assert.ok(family.command, `check family ${name} has no command`);
    assert.ok(family.paths && family.paths.length, `check family ${name} has no paths`);
  }
  for (const [name, suite] of Object.entries(config.suites)) {
    assert.ok(suite.command, `suite ${name} has no command`);
    assert.ok(suite.paths && suite.paths.length, `suite ${name} has no paths`);
  }
  for (const area of config.coverage.areas) {
    assert.ok(area.name && area.paths && area.paths.length, 'a coverage area needs a name and paths');
  }
});
