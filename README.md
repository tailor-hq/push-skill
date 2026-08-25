# push-skill

A Claude Code skill that checks a branch the way a careful reviewer would, then pushes it.

We use a version of this at [Tailor AI](https://tailorhq.ai) so that nobody has to read a diff to keep a bug out of production. This is that skill with everything company-specific stripped out. No dependencies, stock Node.

## What it does when you run it

It rebases on your base branch, then:

1. **Two adversarial review passes.** One reads the code. The other challenges the approach: is this the right design, what does it assume, where does it break. Point the second at a **different model** (`review.secondOpinion`, Codex example included) and you get two failure modes instead of one. Leave it unconfigured and one model runs both passes, which the setup check and every push report say out loud.
2. **Runs the CI you already have, and fills its gaps.** A script picks the checks and end-to-end suites this change can actually break, and if the change arrived without tests, it writes them.
3. **Exercises the real code.** Against your running app, in the browser where there's a UI, including the cases that should do nothing, be refused, fail, or run twice.
4. **A security review that blocks.** Read first, fixed first, then re-checked against the final code, because the fixes moved it.
5. **Repo hygiene.** Writes the PR description, pushes, and reports what ran, what didn't, and what each reviewer found.

If it can't finish something in two or three tries, it stops and hands you the branch with the reason attached.

## The parts worth stealing

**Silence means "run it".** A path matching no rule selects every check family, because nothing re-runs build, lint or unit after a merge: anything skipped there is skipped for good. E2e defaults the same way. You can flip e2e to skip unmapped paths, but only by declaring what runs the full suite after a merge (`e2e.mainBranchSafetyNet`), because that claim is the entire reason skipping is safe. We run ours hourly against main; the validator refuses the setting without an answer.

**Coverage is judged per area, not per file.** A per-file rule fires on nearly every branch in the parts of a codebase covered end to end, and a rule that fires constantly gets ignored inside a week. Mark those areas `advisory` and let the rest block.

**Every finding gets a written decision.** Fixed, noted, or rejected with the line that proves it wrong. A finding nobody decided on is one nobody read.

**The gates name their escape hatches.** "Don't push failing code" doesn't hold. "Don't check out main to prove a failure is pre-existing" does. Every prohibition in `SKILL.md` is there because a model talked itself into shipping that way once.

## Why security gets its own pass

It used to be one word in a bullet: "critical: security, correctness, data loss, breaking changes." That produced reviews with plenty to say about correctness and nothing about authorization. Tell a reviewer to look at four things and it looks hardest at the one it can see in the diff.

Three things make the separate pass work, all of them in `SKILL.md`:

1. **Attack, don't survey.** The brief says try to *cause* a security problem, works a named checklist, and treats "no security impact" with nothing named as a failed pass. It over-reports by design, and every finding gets a recorded disposition.
2. **Latent counts.** A widening no caller reaches today is still a finding, because the next caller is who it's for.
3. **The verdict covers a tree, not a branch.** Every fix cycle mints a new tree, and post-review edits are the ones most likely to delete a guard. Step 10 re-checks whatever moved since the review.

When a finding is about a refusal, the fix gets proven by breaking the check deliberately, watching the tests go red, restoring it, and reading `git diff` before anything is committed. A refusal held up by a test nobody has seen fail isn't held up.

## What you need

| | Why |
|---|---|
| **git and Node 18+** | The scripts. No dependencies beyond that. |
| **Claude Code** | `/push` is a Claude Code skill. Any plan that runs Claude Code runs this. |
| **An OpenAI Codex account and the `codex` CLI** | *Optional but recommended.* This is what makes the second review a different model instead of the same one twice. Without it you get two passes from one model, and every report says so. |
| **A browser automation tool** | *Optional.* For UI changes, the live-run step drives the real app. The [Claude in Chrome](https://claude.ai/chrome) extension, a Playwright MCP server, or a local Playwright script all work. Without one, the skill says the UI was not exercised rather than pretending otherwise. |
| **`gh`, or your host's CLI** | *Optional.* Only for opening the PR. Set `pr.enabled: false` if you open them by hand. |

Nothing here phones home, and the skill makes no network calls of its own. Your diff goes to whichever models your harness is already wired to, and nowhere else.

## Install

**As a plugin, in Claude Code:**

```
/plugin marketplace add tailor-hq/push-skill
/plugin install push-skill@push-skill
```

**Or as a personal skill**, if you would rather not use plugins:

```bash
git clone https://github.com/tailor-hq/push-skill
ln -s "$PWD/push-skill/skills/push" ~/.claude/skills/push
```

Either way, the scripts travel with the skill and resolve through `${CLAUDE_SKILL_DIR}`, so there is nothing to copy into your repo.

Then, in the repo you want to use it on:

```bash
node ~/.claude/skills/push/scripts/init-config.js          # writes push.config.json
$EDITOR push.config.json                                   # answer the TODOs it names
node ~/.claude/skills/push/scripts/init-config.js --check   # validates, dry-runs on your branch
```

(Installed as a plugin, the path is `~/.claude/plugins/marketplaces/push-skill/skills/push/scripts/`. `init-config.js` prints the right path for your install in its own next-steps output.)

Then run `/push` on a branch you would have pushed anyway, and read the report before trusting it.

`init-config.js` guesses your package runner, check command, source directories, test convention, and guideline docs from what is already in the repo. It names what it cannot know as a `TODO`, and `--check` fails while any remain, because a TODO here is a string that would be handed to a shell.

Already have a `/push`? Installed as a plugin the name is namespaced; installed by hand, symlink it under a different directory name.

## Using it from Codex

Codex has no skills system, so there is no `/push` command there. What does work:

- **The scripts run anywhere.** `select-checks.js` and `assess-test-coverage.js` are plain Node and know nothing about Claude. Wire them into a Codex session, a Makefile, or CI.
- **The procedure is readable.** Point Codex at `skills/push/SKILL.md` and it can work the steps in order. The parts that assume a harness (two background reviewers, browser automation) degrade to doing them in sequence.
- **Codex is the second reviewer.** The intended setup is a Claude Code session running `/push` that calls `codex exec` to attack the approach while Claude reviews the implementation. That is `review.secondOpinion.command`, and the example config ships it.

See [AGENTS.md](AGENTS.md), which Codex reads automatically in this repo.

Full adaptation guide (non-Node stacks, non-GitHub hosts, monorepos, CI wiring): **[CUSTOMIZING.md](CUSTOMIZING.md)**.

## Configure

`push.config.json` is the only thing you write, and the only place anything project-specific lives. Nothing about your repo belongs in `SKILL.md`, which is what keeps it updatable.

```jsonc
{
  "git": { "base": "origin/main", "pushRemote": "origin" },
  "ignore": ["docs/**", "LICENSE"],           // selects nothing at all

  "checks": {                                 // unmapped path => ALL of these
    "app": {
      "command": "npm run build && npm run lint && npm test",
      "description": "build, lint and unit tests",
      "paths": ["src/**", "package.json"]
    }
  },

  "suites": {                                 // unmapped path => ALL, unless you declare a safety net
    "checkout": {
      "command": "npx playwright test e2e/checkout",
      "description": "checkout flow, end to end",
      "paths": ["src/checkout/**", "e2e/**"]
    }
  },

  "coverage": {
    "areas": [
      { "name": "src/services", "paths": ["src/services/**"] },
      { "name": "src/components", "paths": ["src/components/**"], "advisory": true,
        "note": "covered by e2e rather than unit tests" }
    ],
    "exempt": ["**/*.d.ts", "src/generated/**"]
  }
}
```

Four fields carry your standards, and they're the ones worth filling in properly:

```jsonc
"review": {
  "guidelines": ["CONTRIBUTING.md", "docs/threat-model.md"],   // both reviewers read these first
  "securitySurfaces": [                                        // appended to the security checklist
    "Any change to PUBLIC_ROUTES in src/middleware/routes.ts: who can now reach what?"
  ],
  "secondOpinion": {                                           // a real second model
    "command": ["codex", "exec", "--output-last-message", "{outputFile}", "{promptFile}"]
  }
},
"exercise": {
  "notes": ["Dev server: npm run dev on :3000", "Sign in as dev@example.com"]
}
```

Your guidelines win over this skill on style and conventions. This skill wins on the gates: what must run, what blocks a push, what gets recorded.

Then check the answers against a real branch before trusting them:

```bash
node scripts/select-checks.js --explain
node scripts/assess-test-coverage.js
```

## The scripts

| | |
|---|---|
| `skills/push/scripts/init-config.js` | Writes a starter config from your repo. `--check` validates it and dry-runs the selector. |
| `skills/push/scripts/second-opinion.js` | Runs your configured second model. Always exits 0; the verdict is `status` in its output file. |
| `skills/push/scripts/session.js` | Per-run scratch dir under `.git/`, and a per-worktree lock so two runs can't clobber each other. |
| `skills/push/scripts/select-checks.js` | Which checks and e2e suites this diff needs. `--explain` shows which rule matched each file. |
| `skills/push/scripts/assess-test-coverage.js` | Which areas changed logic and gained no test. `--strict` exits non-zero on a blocking gap. |
| `npm test` | 78 tests: unit, real-git integration, and tests **for the prose in SKILL.md**. |

That last one isn't a joke. `SKILL.md` is the only thing telling the agent what to run and in what order, and prose breaks quietly: it builds, lints, and tests clean no matter what it says. The regression that earned those tests was a merge-base check that shipped *below* the rebase it was written to prevent, so its "do not run the rebase" line described a rebase that had already happened. `skills/push/scripts/skill-invariants.test.js` asserts order and existence, never wording, so the file stays free to rewrite.

## What it doesn't do

- **Replace judgment on hard changes.** Three tries on a failing test, two on a coverage gap, two on review fixes, then a person. Those ceilings are the design. An area that fights being tested is usually telling you something about the design.
- **Give you a second model for free.** Configure `review.secondOpinion` with a command that runs one. Unconfigured, you get two passes from one model, and the report says so rather than implying otherwise.
- **Know your deploy path.** `no-e2e` and `e2e.unmapped: "none"` both require you to declare what runs the full suite after a merge. Without that, the validator refuses them.
- **Prove anything.** Both reviewers produce false negatives. This raises the floor. See [SECURITY.md](SECURITY.md) for what it is and isn't designed against.
- **Have behavioral evals yet.** The tests prove the instructions still say what they said, not that an agent follows them at 6pm with a failing test. The cases we care about are specified in [evals/](evals/README.md) and haven't been run.

It costs about 6,000 words of context to load. That sounds expensive for a command. It is cheap next to a person reading everything ten agents produce.

## License

MIT.
