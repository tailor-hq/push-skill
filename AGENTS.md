# Working in this repo

This repo is the `/push` skill: a workflow that checks a branch the way a careful reviewer would, then pushes it.

- `skills/push/SKILL.md` is the workflow. It is prose, and it is load-bearing: it is the only thing telling an agent what to run and in what order.
- `skills/push/scripts/` holds the decisions that must not be improvised. Anything mechanical belongs here, not in the prose.
- `npm test` runs everything, including `skill-invariants.test.js`, which asserts things about the English in `SKILL.md`.

If you change `SKILL.md`, keep those invariant tests passing and add to them. If you change a rule, keep its reason next to it: a rule with no stated reason gets shortened back by the next person in a hurry, and then the bug it prevented comes back.

## Using this workflow in Codex

Codex has no skills system, so there is no `/push` command here. Two things do work, and both are useful:

**Run the scripts.** They are plain Node with no dependencies and no Claude-specific assumptions:

```bash
node skills/push/scripts/select-checks.js --explain    # what this diff needs
node skills/push/scripts/assess-test-coverage.js --strict
```

**Follow the procedure.** Read `skills/push/SKILL.md` and work the steps in order. The parts that need a harness (spawning two background reviewers, driving a browser) degrade to doing them yourself in sequence; everything else is the same, and the gates still hold.

Codex is also the reviewer this skill expects on the *other* side: `review.secondOpinion.command` in `push.config.json` points at `codex exec`, so a Claude Code session running `/push` asks Codex to attack the approach while Claude reviews the implementation.
