# Tasks: pi-classifier-provider

Full context: `../SPEC.md` (requirements, contracts) + `plan.md` (ordering, risks).
Commands throughout: `bun run typecheck` (= `tsc --noEmit`), `bun test`.

## Task 1: Spike — pi-ai classifier API surface + auth resolution

**Description:** De-risk the only unknown before building: call pi-ai's built-in
`typesafe-system-one` classify implementation outside the pi runtime, against a throwaway local
HTTP mock, and record (a) which import path works (OQ1), (b) how the `Authorization: Bearer` key
is sourced (model-level vs provider-injected), (c) that `model.baseUrl` drives the request URL
(`POST {baseUrl}/v1/systemone`). Spike output decides the shapes used in Tasks 4 and 6; spike code
is disposable but its conclusions go into `plan.md`.

**Acceptance criteria:**
- [x] Working import for the built-in impl identified and recorded (OQ1 closed)
- [x] Observed and recorded: request URL is `{model.baseUrl}/v1/systemone`, method POST
- [x] Observed and recorded: how the API key reaches `Authorization: Bearer` in a standalone call

**Verification:**
- [x] Spike script/test runs green against a local mock (`bun test` or `bun run` of the spike)
- [x] Conclusions written into `plan.md` (edit "Open Questions" → resolved)

**Dependencies:** None

**Files likely touched:**
- `spike/classify-spike.ts` (or `test/spike.test.ts`, disposable)
- `tasks/plan.md` (record conclusions)

**Estimated scope:** Small (1-2 files)

## Task 2: Package scaffold

**Description:** Create the pi package skeleton: `package.json` with `name: "pi-classifier-provider"`,
`keywords: ["pi-package"]`, `pi: { extensions: ["./extensions/classifier-models.ts"] }`,
`@earendil-works/pi-ai` as `peerDependencies: "*"` (host-provided — never `dependencies`);
TypeScript strict config (NodeNext, `.js` extensions in relative imports); test wiring for
`bun test`. No feature code yet.

**Acceptance criteria:**
- [x] `package.json` declares `pi.extensions`, `keywords: ["pi-package"]`, and pi-ai only as peer dep
- [x] `tsc --noEmit` passes on the skeleton
- [x] `bun test` runs (zero or trivial test) and exits 0

**Verification:**
- [x] Tests pass: `bun test`
- [x] Build succeeds: `bun run typecheck`
- [x] Manual check: `pi install ./` (or `pi -e . --list-models`) loads without error

**Dependencies:** None (can run parallel to Task 1)

**Files likely touched:**
- `package.json`
- `tsconfig.json`
- `test/smoke.test.ts`

**Estimated scope:** Small (1-2 files)

## Task 3: Config loader + validation

**Description:** `src/config.ts`: read `~/.pi/agent/classifier-models.json` and validate it into
`ProviderEntry[]` per SPEC §6.1. Missing file → `null` (caller warns + no-ops). Malformed JSON or
any schema violation throws `Error("~/.pi/agent/classifier-models.json: <path>: <reason>")` —
including `api` other than `"typesafe-systemone"` (reject `llama-cpp-classify` etc. with the
value and provider id in the message). Never log apiKey contents.

**Acceptance criteria:**
- [x] Valid redacted fixture parses to `ProviderEntry[]` with all fields mapped (SPEC §5, §6.1)
- [x] Missing file returns `null`; malformed JSON, bad `baseUrl`, missing `apiKey`, empty `models`,
      bad `contextWindow`/`cost`, and `api: "llama-cpp-classify"` each throw with file path + field
- [x] No `any`; pi-ai types used via `import type` where applicable

**Verification:**
- [x] Tests pass: `bun test test/config.test.ts`
- [x] Build succeeds: `bun run typecheck`
- [x] Manual check: error messages name the file and the offending field

**Dependencies:** Task 2

**Files likely touched:**
- `src/config.ts`
- `test/config.test.ts`

**Estimated scope:** Small (1-2 files)

## Task 4: Registration mapping

**Description:** `src/register.ts`: map `ProviderEntry[]` onto `pi.registerProvider()` calls per
SPEC §6.2 — one call per entry, `apiKey` passed verbatim (pi handles `$VAR`/`!cmd` interpolation),
each model mapped to a `ClassifierModel` (`type: "classifier"`, `api`, model-level `baseUrl`,
`id`, `name`, `contextWindow`, `input`, `cost`), and `classifiers: { "typesafe-systemone":
<pi-ai impl> }` using the Task 1 import decision. Registration idempotent under reload
(no `pi.unregisterProvider()` needed: `registerProvider` is keyed by provider name and replaces
that entry's models).

**Acceptance criteria:**
- [x] One `registerProvider` call per provider entry, named by config key, with that entry's key/url
- [x] Every model mapped with `type: "classifier"`, entry `api`, entry `baseUrl`, full cost metadata
- [x] `classifiers["typesafe-systemone"]` present and delegates to pi-ai's `classifySystemOne`
      over our own `SystemOneTransport` (SPEC §6.3.1 — pi hands the model through unchanged, so
      pi-ai's stock `typesafe-system-one` transport would reject our api id)

**Verification:**
- [x] Tests pass: `bun test test/register.test.ts` (fake `pi` captures calls)
- [x] Build succeeds: `bun run typecheck`
- [x] Manual check: double-invoke of the register function does not double-register

**Dependencies:** Tasks 1, 3

**Files likely touched:**
- `src/register.ts`
- `test/register.test.ts`

**Estimated scope:** Small (1-2 files)

## Task 5: Extension entry

**Description:** `extensions/classifier-models.ts`: the pi extension factory (exactly one default
export) — load config (Task 3) → warn + no-op on missing file → register (Task 4) on valid config,
throw `"<file>: <path>: <reason>"` on invalid. pi awaits async factories before startup model
selection. Wire behavior contract of SPEC §6.2 exactly.

**Acceptance criteria:**
- [x] Missing config file: `console.warn`, no registrations, pi keeps starting
- [x] Invalid config: throws with file path + field (fails loudly through pi)
- [x] Valid config: registers all entries; `/reload` does not double-register

**Verification:**
- [x] Tests pass: `bun test test/register.test.ts` (factory invoked against fake `pi`)
- [x] Build succeeds: `bun run typecheck`
- [x] Manual check: `pi -e . --list-models` loads the extension without error (classifier models
      intentionally never appear in `--list-models` or `/model`)

**Dependencies:** Tasks 3, 4

**Files likely touched:**
- `extensions/classifier-models.ts`
- `test/register.test.ts`

**Estimated scope:** Small (1-2 files)

## Task 6: Integration test — mock `/v1/systemone` (success criterion)

**Description:** `test/classify.integration.test.ts`: stand up a local mock HTTP server as
`baseUrl`; run the extension factory against a fake `pi`; invoke the registered
`classifiers["typesafe-systemone"].classify` with a `ClassifierContext` ({state, questions}:
choice/bool/score). Assert the wire hit and the result mapping (SPEC §9.2) — this is the package's
success criterion (SPEC §2).

**Acceptance criteria:**
- [x] Mock observes `POST /v1/systemone` at the entry's `baseUrl` with `Authorization: Bearer <apiKey>`
- [x] Well-formed response (bool/choice/score answers + usage) maps to `ClassifierResult`
      probabilities and `result.usage`
- [x] A 500 response surfaces as a normalized provider error

**Verification:**
- [x] Tests pass: `bun test test/classify.integration.test.ts`
- [x] Build succeeds: `bun run typecheck`
- [x] Manual check: assertions cover URL, method, auth header, result shape, error path

**Dependencies:** Tasks 4, 5

**Files likely touched:**
- `test/classify.integration.test.ts`

**Estimated scope:** Small (1-2 files)

## Task 7: README + local install smoke + manual real-key smoke

**Description:** README: install (`pi install ./pi-classifier-provider`), config format (redacted
sample from SPEC §6.1), security note (apiKey interpolation, never commit real keys). Then the
end-to-end manual smoke with the user's real config and key (never copied into the repo):
`pi install ./`, `pi -e . --list-models`, then `models.classify("sample/jev-latest", …)` from
codemode.

**Acceptance criteria:**
- [x] README covers install, config schema, error behavior, security note
- [x] Repo grep confirms no real key material (`apikey_2141` prefix absent from VCS-tracked files)
- [x] Real-key smoke: classify call reaches `{baseUrl}/v1/systemone` and returns a
      `ClassifierResult` (SPEC §2 success criterion, live)

**Verification:**
- [x] Tests pass: `bun test` (full suite)
- [x] Build succeeds: `bun run typecheck`
- [x] Manual check: live classify smoke succeeds and is reported back

**Dependencies:** Task 6

**Files likely touched:**
- `README.md`
- (none else — smoke uses the user's `~/.pi/agent/classifier-models.json` in place)

**Estimated scope:** Small (1-2 files)

---

## Checkpoint: After Tasks 1-2 (Foundations)
- [x] Spike conclusions recorded in `plan.md` (OQ1 closed, auth resolution known)
- [x] `bun test` and `bun run typecheck` pass
- [x] Package loads via `pi -e . --list-models`
- [x] Review with human before proceeding

## Checkpoint: After Tasks 3-5 (Core)
- [x] All tests pass (`bun test`), typecheck clean
- [x] Config errors fail loudly with file + field; missing file warns and no-ops
- [x] Factory registers correct models against fake `pi`; no double-registration on reload
- [x] Review with human before proceeding

## Checkpoint: After Tasks 6-7 (Complete)
- [x] All tests pass, typecheck clean
- [x] Integration test proves `POST {baseUrl}/v1/systemone` + Bearer key + `ClassifierResult`
- [x] No real key material in the repo
- [x] Live smoke with real key succeeds
- [x] Ready for review
