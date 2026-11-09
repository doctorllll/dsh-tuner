# Changelog

## 0.5.2 — 2026-11-09

- The estimated post-compaction floor (used until a model has two compactions of its own) starts from the conversation's opening request, not from the model's first request. A model switched in mid-session used to inherit the whole conversation as its "fixed" overhead, so every lower threshold looked like it would compact on each step and it was told to stay at 80%.

## 0.5.1 — 2026-11-06

- Rebuilding, applying and restoring defaults keep your other changes to the preset; a preset is rebuilt only when it names rows the running DSH no longer ships.
- Tool-side advice names this profile's own `AGENTS.md` and hook configuration files.

## 0.5.0 — 2026-11-06

- Overview + detail UI on the app's theme tokens (light and dark).
- Compaction health judged against the threshold in force at the time of each run; advice by failure cause.
- Model-side (retries, reasoning effort) and tool-side (run_code timeouts, edits without a read, large outputs, hook overhead) recommendations.

## 0.4.0 — 2026-11-06

- Per-model compaction thresholds (`modelPolicies`), accounting for the measured post-compaction floor and excluding thresholds that would compact on every step.
- Compaction health card; cache card tells expired caches from prefix changes.

## 0.3.0 — 2026-11-06

- Preset overrides are rebuilt on the running DSH's defaults, so an upgrade that drops a row no longer breaks sessions of that mode.

## 0.2.0 — 2026-11-05

- One-click apply for the compaction card, with read-back verification, rollback and restore defaults.

## 0.1.x — 2026-11-05

- Read-only report per module and the `/tuner` command.
