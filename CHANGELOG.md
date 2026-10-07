# Changelog

## Unreleased

- Also validate DSH `0.2.0-rc.2` and allow it explicitly alongside `0.2.1-alpha.1`.
- Run the full behavioral suite plus the real compatibility gate and bundle
  metadata checks against both pinned runtime/Cordis families on Node 22/24.
- Document GitHub installation separately from the npm dependency registry.

- Align with the current Bash-only Minimal preset.
- Replace removed `Session.events` access with a durable session projection.
- Fix resume, compaction, off/on toggles, child exclusion, and tool-provider restoration.
- Reassemble after registry changes; fall back atomically for protected complete
  prompts, non-native Bash catalogs, and scoped tool conflicts.
- Persist deferred instruction updates until committed, including across restart and partial delivery.
- Keep the selected provider alive through its tool batch and remove it on plugin unload.
- Reuse DSH browser authentication; validate state requests and persist before changing memory.
- Make client errors recoverable, reject malformed state, guard duplicate clicks
  and stale effects, and use a document-relative route.
- Add runtime-backed host tests, client race tests, and Node 22/24 CI coverage.

## 0.1.0 - 2026-08-15

- Initial public release.
- Adds Minimal-compatible first-request conditioning for DSH Web root sessions.
- Adds a persistent composer switch labelled `首轮精简`.
- Restores the selected preset after the first durable model response or tool call.
