# Implementation Plan: pi-classifier-provider

## Overview

A pi package whose provider extension reads `~/.pi/agent/classifier-models.json` and registers its
entries as pi classifier models via `pi.registerProvider()`, reusing pi-ai's System One wire logic
(`classifySystemOne` + `postClassifierRequest`/`parseClassifierUsage`) over our own
`SystemOneTransport` — no custom wire code, no custom HTTP code. Full requirements and
contracts live in `../SPEC.md` — the spec is the source of truth; this plan only orders the work.

## Architecture Decisions

- Config-driven registration: one `pi.registerProvider(configKey, …)` per `providers.<id>` entry;
  each model carries its provider's `baseUrl` (model-level `baseUrl` wins over provider endpoint).
- No HTTP code in this package: `classifiers["typesafe-systemone"]` delegates to pi-ai's
  `classifySystemOne` over our own `SystemOneTransport` (SPEC §6.3.1) — pi-ai's stock transport
  cannot be used because it rejects our api id. Import path resolved by Task 1 spike (OQ1),
  corrected in Task 6.
- Fail loudly on malformed/invalid config (`<file>: <path>: <reason>`); warn + no-op only on
  missing file.
- TypeScript strict, Bun (`bun test`, `tsc --noEmit`); `@earendil-works/pi-ai` is a host-provided
  `peerDependencies: "*"` — never a regular dependency.
- The real TypeSafe API key in the sample config is never embedded in code/tests/docs/VCS.

## Task List

Ordered index (full task specs with acceptance criteria in `todo.md`):

### Phase 1: Foundations
- [x] Task 1: Spike — pi-ai classifier API surface + auth resolution (resolves OQ1)
- [x] Task 2: Package scaffold (package.json, tsconfig, test wiring)

### Checkpoint: Foundations
- [x] Spike conclusions recorded; scaffold typechecks and tests run

### Phase 2: Core
- [x] Task 3: Config loader + validation (`src/config.ts`)
- [x] Task 4: Registration mapping (`src/register.ts`)
- [x] Task 5: Extension entry (`extensions/classifier-models.ts`)

### Checkpoint: Core
- [x] Config + registration + entry tested; factory works against fake `pi`

### Phase 3: End-to-end & Polish
- [x] Task 6: Integration test — mock `/v1/systemone` server (success criterion)
- [x] Task 7: README + local install smoke + manual real-key smoke

### Checkpoint: Complete
- [x] All acceptance criteria met; ready for review

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| pi-ai classifier impl ignores model-level `baseUrl` (hardcodes provider endpoint or env) | High | **Cleared by Task 1 spike**: request URL is `new URL("systemone", baseUrl + "/")` — model-level `baseUrl` fully drives it |
| Auth resolution ambiguous (pi-injected provider apiKey vs `model.apiKey`) in standalone tests | Med | **Cleared by Task 1 spike**: only `options.apiKey` is read; `model.apiKey` is ignored |
| Real user config `baseUrl` is `https://api.typesafe.ai` (no `/v1`) so request goes to `/systemone`, not `{baseUrl}/v1/systemone` | High | **Resolved**: registration normalizes `baseUrl` (strip trailing slashes, append `/v1`) in `resolveBaseUrl` (SPEC §6.2.1); the config is used unchanged |
| User config `api` is `"typesafe-systemone"` (no hyphen), which pi-ai's built-in transport rejects | High | **Resolved**: `"typesafe-systemone"` is our accepted id and our own transport speaks it (SPEC §6.3.1); any other value is rejected by Task 3's loader with the field path and value |
| Extension reload (`/reload`) double-registers providers | Med | **Resolved**: `registerProvider` is keyed by name and replaces that entry's models, so `pi.unregisterProvider()` is not needed; Task 4/5 tests assert idempotency |
| Real API key leaks into repo | High | Redacted fixture everywhere except the user's own config file; grep-based check in Task 7 |
| pi-ai export path differs from assumption (`…/api/typesafe-system-one(.lazy)`) | Low | **Cleared by Task 1 spike**: both subpaths import and resolve via the `"./api/*"` exports map |

### Spike Findings (Task 1)

Spike: `spike/classify-spike.ts` (bun, disposable). Mock `Bun.serve` on an ephemeral 127.0.0.1
port; `bun run spike/classify-spike.ts` exits 0 with all checks passing. Exact evidence below.

- **Import (OQ1 resolved, then superseded in Task 6):** both `import { typesafeSystemOneApi } from
  "@earendil-works/pi-ai/api/typesafe-system-one.lazy"` and the eager `{ classify }` from
  `…/api/typesafe-system-one` are importable (package `exports` maps `"./api/*"`). The lazy
  factory's return value (`{ classify }`) satisfies `ProviderClassifier`, matching pi-ai's own
  built-in providers (`dist/providers/typesafe.js` line 14) — **but it is unusable for us**.
  `classifySystemOne` asserts `model.api === transport.api`, while pi dispatches classifiers by
  `model.api` and passes the model through unchanged, so every call returned
  `"Unsupported classifier API: typesafe-systemone"` (proved by a hand-run probe and by the RED
  run of `test/classify.integration.test.ts`). Final decision: import `classifySystemOne` from
  `"@earendil-works/pi-ai/api/system-one-shared"` and run it over our own `SystemOneTransport`
  whose `api` is `SUPPORTED_API` (SPEC §6.3.1, `src/register.ts`).
- **Request URL:** `POST` to `new URL("systemone", baseUrl.replace(/\/+$/, "") + "/")` (source:
  `dist/api/typesafe-system-one.js`). Observed literally: baseUrl `http://127.0.0.1:PORT` → path
  `/systemone`; baseUrl `http://127.0.0.1:PORT/v1` → path `/v1/systemone`. The `/v1` is **not**
  added by pi-ai; it must already be in `baseUrl`. pi-ai's built-in `dist/providers/data/typesafe.json`
  uses `https://api.typesafe.ai/v1/`, hence `/v1/systemone`.
- **Auth (resolved):** `postClassifierRequest` reads **`options.apiKey` only** (never
  `model.apiKey`; `BaseModel` has no `apiKey` field). Missing → result `stopReason: "error"`,
  message `No API key for provider: <provider>`. Observed headers: `authorization: Bearer
  spike-fake-key` and `content-type: application/json`.
- **Wire shapes:** request body `{"model": <id>, "state": …, "questions": …}`; `bool` questions
  are rewritten to wire type `noul`. Response `{"answers": {<id>: {type: "noul"|"choice"|"score",…}},
  "usage": {"input_tokens": N, "output_tokens": N}}`. Wire `noul` maps back to
  `{type:"bool", probability}`; usage is priced via the model `cost`.
- **Built-in api id:** `"typesafe-system-one"` (hyphenated) — confirmed in
  `dist/providers/data/typesafe.json`, `dist/api/typesafe-system-one.js`, and every built-in provider
  that registers it (`typesafe.js`, `openrouter.js`, `opencode.js`, `vercel-ai-gateway.js`).
  **Do not register under this id** — our config/registry id is `"typesafe-systemone"` (§6.3.1).
- **Config mismatch (finding; now resolved):** the user's `~/.pi/agent/classifier-models.json`
  uses `"api": "typesafe-systemone"` (no hyphen). Its `baseUrl` is `https://api.typesafe.ai`
  (no `/v1`), so a naive pass-through would POST `/systemone`, not `/v1/systemone`. Both issues
  are handled in code: the loader accepts exactly `"typesafe-systemone"`, and registration
  normalizes `baseUrl` to end in `/v1` (SPEC §6.2.1). The `api`-id mismatch is also why we cannot
  reuse pi-ai's stock transport — see the *Import* bullet above.

## Open Questions

- OQ1 — **Resolved (Task 1), superseded (Task 6):** `typesafeSystemOneApi()` satisfies
  `ProviderClassifier`, but its transport rejects any model whose `api` is not
  `"typesafe-system-one"`, and pi dispatches classifiers by `model.api` while passing the model
  through unchanged. `src/register.ts` therefore registers `classifySystemOne` over our own
  `SystemOneTransport` with `api: SUPPORTED_API` (SPEC §6.3.1). Regression guard:
  `test/classify.integration.test.ts`.
- API key resolution — **Resolved (Task 1):** `classify(model, context, options)` reads
  **`options.apiKey`** only and sends `Authorization: Bearer <options.apiKey>`. `model.apiKey` is
  ignored (it is not part of `ClassifierModel`/`BaseModel`).
- OQ2: npm publish scope? (non-blocking; `keywords: ["pi-package"]` is set either way)

## Notes

- The skill's `See Also` reference (`~/.agent/references/definition-of-done.md`) does not exist on
  this machine; the spec's §7 Code Style + §9 test plan serve as the standing bar instead.
