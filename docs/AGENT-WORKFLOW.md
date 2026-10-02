# Agent workflow

How this project is built with AI agents — and how to reproduce the approach in **any** tool.

This describes a *method*, not configuration. Nothing here is specific to one agent product:
the portable contract is [`AGENTS.md`](../AGENTS.md), the file every major coding agent reads
(Claude Code, Cursor, Codex, OpenCode, …). Tool-specific config (`.opencode/`, `CLAUDE.md`,
`.cursor/rules`) is optional and additive; the core below is not.

## The shape: one lead, several specialists

A single **lead agent** owns the goal end to end — it plans, delegates, integrates and verifies.
Specialists do narrow jobs with tight permissions and fresh context, which keeps their mistakes
small and reviewable. Delegate when a task matches a specialty; otherwise just do the work — a
specialist for everything is its own failure mode.

| Role | Does | Read-only? |
|---|---|---|
| **Lead / orchestrator** | Owns the goal; plans, delegates, integrates, verifies, hands off | no |
| **Explorer** | Navigates unfamiliar code before edits: find files, trace dependencies | yes |
| **Environment** | Discovers local tool paths/versions (e.g. `node` not on `PATH`) | yes |
| **Reviewer** | Regression/risk pass before a merge or handoff | yes |
| **Security auditor** | Secrets, auth, input validation, injection at milestones | yes |
| **Infrastructure** | Terraform/Bicep/Azure work when the task is IaC | mixed |
| **GitHub** | PRs, issues, CI, releases via the platform CLI | mixed |
| **General** | Multi-step research, planning, decision records | no |

Give read-only roles read-only tools. It is what lets a reviewer be trusted to *find* problems
rather than "fix" them mid-review.

## The loop

1. **Understand and classify.** Restate the goal as acceptance criteria that can pass or fail.
   Note the data sensitivity before anything leaves the machine.
2. **Plan.** For non-trivial work, write the task list *before* writing code.
3. **Implement.** The smallest correct change; match the existing style even where you would
   do it differently.
4. **Verify.** Run the narrowest meaningful check — here, `npm test`, then exercise the actual
   page. "Looks correct" is not "runs correctly".
5. **Review.** At milestone boundaries, run a read-only reviewer (and a security auditor when
   auth, data or infra is touched).
6. **Hand off.** State what changed, what was verified, and the residual risks — including the
   exact blocker if incomplete.

## The guardrails that make it safe

- **Tests are the contract.** A green suite is the objective signal an agent can act on. For a
  bug, write a test that fails for the right reason *first*; the bug is fixed when it passes.
- **Verify by running, not by reading.** This repo's own history has three failures that passed
  the suite and were obvious the moment the thing ran — see
  [*What the tests do not prove*](../AGENTS.md#what-the-tests-do-not-prove).
- **Risk gate.** Changes to auth, payments, cryptography, data access or production
  infrastructure get **human** review before merge, whatever the automated gates say.
- **Secrets never enter the loop.** No credentials in prompts, files, commits or archives;
  classify data before sending it to any model, and keep personal and production contexts
  isolated.
- **Audit trail.** Architectural decisions are recorded in [`decisions.md`](decisions.md) with
  their rationale and rejections; AI-authored commits say so in the body. The diff records the
  *what*; the log records the *why*.
- **Automate the guardrail.** CI runs the tests (and a dependency audit) on every push and PR;
  branch protection makes `main` require a PR and a green check.

## The knowledge layer

An agent with no memory of the project should become productive by reading, in order:

| File | What it gives |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | The portable contract: architecture map, commands, conventions, the traps that bit this codebase, the working rules and governance |
| [`decisions.md`](decisions.md) | Why the code is shaped this way — numbered, with what was rejected |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the pieces fit together, data model, API surface |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | Local workflow, testing, gotchas |
| [`SECURITY.md`](../SECURITY.md) | Threat model and the risks knowingly accepted |
| the test suite | The executable definition of "done" |

That set is the whole point of putting the rules in the repository rather than in one vendor's
global config: it travels with a clone, and it works for a human too.

## Anti-patterns we hit (and you will)

- **Green suite ≠ working feature.** Add the check that proves the thing works, not just the
  unit tests.
- **Confident wrong diagnosis.** Reproduce before you fix; never write a fix for a problem you
  have not confirmed.
- **Scope creep.** Touch only what the request needs; park unrelated "improvements".
- **Silent guessing past confusion.** Stop and flag it instead of pushing through.
- **Trusting a green check as proof.** When a dependency's major version bumps, run the suite
  *against that version on the branch* before merging — not after.

## Worked example: shipping v1.0.0 of this repo

The loop, in the order it actually happened:

1. **Understand** — "generalise the macjuu.com services page into a reusable template", broken
   into acceptance criteria (rename, neutral seeds, empty data, docs, tests green).
2. **Plan + explore** — read the source before editing; identify every instance-specific
   reference.
3. **Implement** — surgical renames and neutral seed copy; excluded `.env` and `data/`.
4. **Verify** — `npm test` (271 passing), then booted the dev server and exercised `/`,
   `/credits`, `/admin` and the API.
5. **Review** — a read-only reviewer pass found four cosmetic leftovers that were then fixed;
   the test suite was re-run.
6. **Harden** — CI (tests + `npm audit`), Dependabot, branch protection, SECURITY/CONTRIBUTING/
   LICENSE.
7. **Dependency majors** — `express-rate-limit` 7 → 8 was merged only after running the full
   suite on the bump branch; the Node base image bump was followed by aligning CI and the docs.
8. **Release** — changelog, tag, GitHub release; then the README screenshot was captured from a
   seeded demo server and verified by inspecting the rendered DOM, not by eyeballing.

## Adopting this in your project

- [ ] Write `AGENTS.md` **first** — architecture map, commands, conventions, and the traps you
      have actually hit. This is the single highest-leverage file.
- [ ] Have a test suite before agents touch the code; it is the contract they work against.
- [ ] Keep a decision log — the *why* and the rejected options.
- [ ] Define "done" as something runnable, and make the agent run it.
- [ ] Keep secrets out and classify data before it reaches a model.
- [ ] Route risky changes (auth, data, infra) to a human.
- [ ] Wire the guardrail into CI and protect the branch.
- [ ] Treat tool-specific config as optional sugar; the portable core is the docs, the tests and
      the decision log.