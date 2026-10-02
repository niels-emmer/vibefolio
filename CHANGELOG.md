# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- [`docs/AGENT-WORKFLOW.md`](docs/AGENT-WORKFLOW.md) — a tool-agnostic description of how the
  project is built with agents (one lead with specialist subagents, the understand → verify
  loop, the guardrails) so other agentic developers can reproduce the approach.

### Security

- Initial security policy published (`SECURITY.md`): threat model, controls, and
  private vulnerability reporting.

## [1.0.0] — 2026-10-02

### Added

- Initial public release: **vibefolio**, a generalised fork of the private macjuu.com
  services page (see `docs/decisions.md` D27).
- Everything macjuu-specific generalised: package/container names, the backup archive
  format (`vibefolio-backup`), User-Agent strings, and every domain/branding fallback.
- Neutral seed copy for the editable feedback/credits pages and the default credit lines;
  the services table starts empty for each new deployment.
- Editor, CI, and contribution metadata: `.editorconfig`, GitHub Actions CI
  (`npm ci` + `npm test`), Dependabot (npm, Docker, GitHub Actions), issue and PR
  templates.
- Documentation for reuse: this changelog, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and
  `LICENSE` (MIT).

[Unreleased]: https://github.com/niels-emmer/vibefolio/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/niels-emmer/vibefolio/releases/tag/v1.0.0