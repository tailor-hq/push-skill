# Changelog

## 1.0.0

First public release.

Six mechanisms standing in for a human reviewer: a selector that decides which
checks and e2e suites a diff can break, two review passes pinned to one commit,
an adversarial security pass that blocks and is re-checked against the tree
being pushed, a per-area coverage gate, a step that runs the code against a live
system, and gates that close each rationalization by name.

Everything project-specific lives in `push.config.json`. The scripts ship with
the skill and run from `${CLAUDE_SKILL_DIR}`, so there is nothing to copy into a
repo to use `/push`.

Packaged as a Claude Code plugin (`/plugin marketplace add tailor-hq/push-skill`),
installable by symlink as a personal skill, and usable from Codex through
`AGENTS.md` and the scripts.

78 tests: unit, real-git integration, and assertions on the prose in `SKILL.md`.
Behavioral evals are specified in `evals/` and not yet run.
