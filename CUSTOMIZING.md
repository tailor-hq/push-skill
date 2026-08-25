# Making it yours

The skill ships with no opinions about your repo. Everything project-specific is in `push.config.json`, which means adopting your own conventions is an edit to your files, not a fork of `SKILL.md`.

## Fifteen minutes, start to finish

```bash
# plugin install is the short path; this is the manual one
git clone https://github.com/tailor-hq/push-skill
ln -s "$PWD/push-skill/skills/push" ~/.claude/skills/push
export SKILL=~/.claude/skills/push

cd your-repo
node $SKILL/scripts/init-config.js                # writes push.config.json
$EDITOR push.config.json                          # answer the TODOs
node $SKILL/scripts/init-config.js --check        # validates, and dry-runs on your branch
node $SKILL/scripts/select-checks.js --explain    # see which rule matched each file
```

Then run `/push` on a branch you would have pushed anyway, and read the report before you trust it. The scripts run from the skill directory, so there is nothing to vendor into your repo unless you also want CI to call them.

`init-config.js` guesses from what your repo already has: the package runner from your lockfile, the check command from the scripts in `package.json`, source directories by file density, your test convention by counting which one you actually use, and your guideline docs by name. It marks everything it cannot know as a `TODO`, and `--check` fails while any remain, because a TODO here is a string that would be handed to a shell.

## The two decisions no tool can make for you

**Which paths can reach which e2e suite.** The map is an inclusion map: a file selects a suite only when it feeds a flow that suite exercises. Guessing wide makes every branch run everything, which is the same as having no map.

**Which coverage areas block, and which only advise.** Report per area, never per file. In the parts of a codebase covered end to end rather than by unit tests, a per-file rule fires on nearly every branch, and a rule that fires constantly gets ignored inside a week, taking the signal you wanted with it. Mark those areas `advisory` and let the rest block.

## Your review standards

Put them in your repo and point the config at them:

```jsonc
"review": {
  "guidelines": ["CONTRIBUTING.md", "docs/style-guide.md", "docs/threat-model.md"],
  "securitySurfaces": [
    "Any change to PUBLIC_ROUTES in src/middleware/routes.ts: who can now reach what?",
    "Any raw SQL outside src/db/queries: we require the query builder everywhere else."
  ]
}
```

Both reviewers read `guidelines` before reviewing. `securitySurfaces` is appended verbatim to the Pass 0 checklist, and it is the highest-value field in the file: the generic checklist covers what is true of most systems, and these are the soft spots that are true of yours.

When your guidelines and `SKILL.md` disagree, your guidelines win on style and conventions. `SKILL.md` wins on the gates: what must run, what blocks a push, what gets recorded. Keep that boundary or the gates erode one exception at a time.

## Your stack

**Not Node.** Nothing in the skill assumes it except its own scripts, which need Node only to run themselves. Point `checks` at `pytest`, `go test`, `bundle exec rspec`, `cargo test`, `make verify`, whatever you run. Add your extensions to `coverage.logicExtensions` and your naming to `coverage.testGlobs` if they are unusual.

**Not GitHub.** `pr.createCommand` and `pr.updateCommand` are argv arrays run without a shell, with `{title}` and `{body}` substituted as single arguments, so `glab`, `bb`, a curl call, or your own script all work. Keep them arrays: a PR title is model output, and a shell string would make its quotes and backticks syntax. Set `pr.enabled` to false if you push straight to a branch and open PRs by hand.

**Monorepo.** Give each package its own check family and its own coverage areas. That is the case the selector pays off in most: a branch touching one package runs one family instead of all of them.

**A real second model.** `review.secondOpinion.command` is an argv command run without a shell, with `{promptFile}` and `{outputFile}` substituted. The Codex example:

```jsonc
"secondOpinion": {
  "command": ["codex", "exec", "--output-last-message", "{outputFile}", "{promptFile}"]
}
```

Any CLI that takes a prompt and writes an answer works the same way. Leave it out and one model runs both passes: `--check` says so, and so does every push report. That is the honest description of one blind spot, and it is very different from what the word "adversarial" implies.

**Skipping e2e.** `e2e.unmapped` is `"all"` by default, which assumes nothing about your pipeline. To skip e2e on unmapped paths, say what catches it later:

```jsonc
"e2e": {
  "unmapped": "none",
  "mainBranchSafetyNet": {
    "description": "Full Playwright suite runs hourly against main; only a passing commit reaches staging.",
    "workflow": ".github/workflows/e2e-scheduled.yml"
  }
}
```

`--check` refuses `"none"` without it, and the `no-e2e` argument is refused the same way. The declaration is the whole argument for skipping, so it has to exist somewhere a reader can find it.

## Wiring it to CI

The scripts are the useful half here, because CI can run the same selector the skill did:

```bash
node $SKILL/scripts/select-checks.js --base origin/main       # what this diff needs
node $SKILL/scripts/assess-test-coverage.js --strict          # non-zero on a blocking gap
```

For CI, vendor `skills/push/scripts/` into the repo so the workflow does not depend on a skill installed on someone's laptop.

Two ways teams use it. Run the selector in CI to skip jobs a diff cannot break, so CI and the local run agree by construction. Or run `--strict` as a required check, so the coverage gate holds even for branches pushed without the skill.

If you also want CI to skip work the local run already did, have the skill record what passed on the commit (a trailer in the message, or a commit status) and have CI read it. Keep two properties or it will quietly rot: the claim must be scoped to one commit so it cannot carry forward to a push nobody verified, and a missing or unreadable claim must fall back to running everything.

## Turning parts off

Every mechanism is load-bearing in a different direction, so before you drop one, know what stops covering you:

| Turn off | What you lose |
|---|---|
| The selector | Scope becomes a judgment call the agent makes while it is trying to finish. |
| Reviewer B | One model, one blind spot, and no argument about the approach. |
| Pass 0 | The finding class whose cost is paid by someone other than the author. |
| The coverage gate | Branches that ship "tested" with no new assertions. |
| `unclaimedBlocks` | A new directory nobody wrote a rule for, passing because no rule claimed it. |
| The live run | Every defect a mock's assumptions hid, which is most of the interesting ones. |
| The tree re-check | A clean security verdict about a tree you are not pushing. |

## When you change SKILL.md

Keep `skills/push/scripts/skill-invariants.test.js` passing, and add to it. It asserts order and existence, never wording, so the file stays free to rewrite. The regression that earned it: a merge-base check written to prevent a bad rebase shipped *below* the rebase it was meant to gate, so its "do not run the rebase" instruction described a rebase that had already happened. Prose builds, lints and tests clean no matter what it says, so it needs tests like anything else that decides what happens.

Write the reason next to every rule you add. A rule with no stated reason gets shortened back by the next person who reads it in a hurry, and then the bug it prevented comes back.

## Running more than one push at once

Different worktrees run in parallel freely. Two runs in the *same* worktree do not: `session.js` takes a per-worktree lock and the second one refuses rather than overwriting the first one's review files. Scratch state lives under `.git/push-skill/`, so it never shows up in `git status` and can't be swept into a commit.

If a run dies without releasing the lock, it goes stale after two hours, or you can delete `.git/push-skill/lock.json`. The skill will not delete it for you, because "another push is running" and "a push crashed" look identical from here and only one of them is safe to steamroll.
