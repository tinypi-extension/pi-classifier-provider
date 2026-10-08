# SPEC — pi-classifier-provider

Single capability: a pi package whose provider extension reads `~/.pi/agent/classifier-models.json`
and registers its entries as pi **classifier** models (TypeSafe System One wire protocol).

## Assumptions (correct me now or I'll proceed with these)

1. Config path is fixed at `~/.pi/agent/classifier-models.json`; no env override in v1.
2. Missing config file → warn and register nothing (pi keeps starting). Malformed JSON or any
   schema violation — including `api` other than `"typesafe-systemone"` — **fails loudly**
   (the extension throws a precise error; pi surfaces extension errors).
3. One pi provider registration per `providers.<id>` entry; the config key is the provider name.
4. The `/v1/systemone` wire protocol is **not** implemented here: the package reuses pi-ai's
   System One wire logic — `classifySystemOne` from `@earendil-works/pi-ai/api/system-one-shared`
   (which also owns `postClassifierRequest`, retries, timeouts, and `parseClassifierUsage`) — and
   supplies its own `SystemOneTransport` that mirrors pi-ai's URL/payload/output behavior while
   declaring our own api id `"typesafe-systemone"` (§6.3.1). Our job is registration + mapping.
   pi-ai's built-in `typesafe-system-one` transport cannot be reused directly: pi dispatches
   classifiers by `model.api` and passes the model through unchanged, and that transport rejects
   any model whose `api` is not its own id — so `typesafeSystemOneApi()` fails every call with
   `"Unsupported classifier API: typesafe-systemone"` (proved by the Task 6 integration test).
   Because the transport emits `{model.baseUrl}/systemone`, registration normalizes the
   configured `baseUrl` (API root) to end in `/v1` (§6.2.1).
5. Config `apiKey` is passed verbatim to `ProviderConfig.apiKey`; pi applies its normal
   interpolation (`$NAME`, `${NAME}`, `!cmd`, `$$`, `$!`).
6. Dev workflow is TypeScript + Bun (`bun test`, `tsc --noEmit`); the package is consumed locally
   (`pi install ./pi-classifier-provider`) first, npm publish later.
7. The real TypeSafe key that exists in the sample config is never embedded in code, tests, docs,
   or version control.

## 1. Problem

Pi users running TypeSafe System One classifier/decision models (e.g. `jev-latest`) behind their
own `baseUrl` and API key have no declarative way to expose them as pi classifier models. The
built-in TypeSafe provider assumes a single `TYPESAFE_API_KEY` and its own model list; editing
provider config by hand does not scale across multiple endpoints/keys.

## 2. Goals

- G1: Read `~/.pi/agent/classifier-models.json` (same nesting as `models.json`).
- G2: Register every entry as pi classifier models via the custom-provider API
  (`pi.registerProvider`), one registration per provider entry, carrying that entry's
  `baseUrl` + `apiKey`.
- G3: `classify()` calls `POST {baseUrl}/v1/systemone` with the entry's apiKey and parses the
  response — delegated to pi-ai's `classifySystemOne` over our own `SystemOneTransport` (§6.3.1).
- G4: Invalid config fails loudly with file path + offending field; only `api:
  "typesafe-systemone"` is accepted.
- G5: Distributable as pi package `pi-classifier-provider` (installable via `pi install`).

**Success criterion:** a classify call on a registered model reaches `{baseUrl}/v1/systemone`
with that entry's apiKey and returns a parsed `ClassifierResult` (probabilities + usage).

## 3. Non-Goals

- No other classifier APIs in v1 (`llama-cpp-classify`, `openai-decisions`, …) — rejected at
  validation with a clear message.
- No chat or image models, no `refreshModels`/live discovery, no OAuth, no config writer, no UI.
- No custom HTTP/wire-protocol code (pi-ai owns `/v1/systemone`, retries, usage parsing).

## 4. Structure

Single project, single capability → no capability map. Two implementation modules:
config loading/validation, and pi registration. See §8.

## 5. Core Entities

**ProviderEntry** (config `providers.<id>`) — `id` (config key), `baseUrl: string`,
`api: "typesafe-systemone"`, `apiKey: string`, `models: ModelEntry[]`.

**ModelEntry** (config `providers.<id>.models[]`) — `id`, `name`, `contextWindow: number`,
`input: ModelInputKind[]` (`"text" | "image"`, e.g. `["text"]`), `cost: { input, output, cacheRead, cacheWrite }` (numbers).

**Runtime types (pi-ai `types.d.ts`, source of truth, not redefined here):**
`ClassifierModel` (`type: "classifier"`, `api`, `contextWindow`, `input`, `cost`),
`ClassifierContext` (`{ state, questions }`; question kinds `choice | bool | score` with
probabilities), `ClassifierResult` (per-question probabilities; token usage in `result.usage`),
`ClassifierOptions` (includes `temperature`, abort signal).

## 6. Interfaces

### 6.1 Config file contract (`~/.pi/agent/classifier-models.json`)

```json
{
  "providers": {
    "sample": {
      "baseUrl": "https://api.typesafe.ai",
      "api": "typesafe-systemone",
      "apiKey": "…",
      "models": [
        {
          "id": "jev-latest",
          "name": "Jev latest",
          "contextWindow": 64000,
          "input": ["text"],
          "cost": { "input": 0.042, "output": 0, "cacheRead": 0.042, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Validation rules: `providers` required object; per entry `baseUrl` (absolute http(s) URL), `api`
(required, exactly `"typesafe-systemone"`), `apiKey` (non-empty string), `models` (non-empty
array); per model `id`, `name`, `contextWindow` (positive int), `input` (non-empty array of
`"text" | "image"`),
`cost` (4 numeric fields, present). Unknown `api` values throw listing the value and the provider id.

### 6.2 Extension entry (`extensions/classifier-models.ts`)

Default export: the pi extension factory (`pi.registerProvider()` is called from it; pi awaits
async factories before startup model selection).

Per ProviderEntry it calls the **legacy registration form**:

```typescript
pi.registerProvider(entry.id-or-derived-name, {
  apiKey: entry.apiKey,                    // pi resolves $VAR / !cmd interpolation
  models: entry.models.map((m) => ({
    type: "classifier",
    api: entry.api,
    baseUrl: resolveBaseUrl(entry.baseUrl), // {root}/v1; model-level baseUrl wins
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    input: m.input,
    cost: m.cost,
  })),
  classifiers: {
    "typesafe-systemone": {
      classify: (model, context, options) =>
        classifySystemOne(systemOneTransport, model, context, options), // §6.3.1
    },
  },
});
```

Must accept the real host type: `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"`
(devDependency, types only — never a runtime import).

**6.2.1 baseUrl normalization.** Config `baseUrl` is the API **root** (e.g.
`https://api.typesafe.ai`). pi-ai's `typesafe-system-one` transport builds the request URL as
`{model.baseUrl}/systemone` and never adds `/v1`, so registration normalizes: strip trailing
slashes, then append `/v1` unless the path already ends in `/v1`. Both
`https://api.typesafe.ai` and `https://api.typesafe.ai/v1` therefore reach
`POST {root}/v1/systemone`.

Behavior contract: missing file → `console.warn` + no-op; parse/validation failure → `throw
Error("~/.pi/agent/classifier-models.json: <path>: <reason>")`; registrations are idempotent on
`/reload` because `registerProvider` is keyed by provider name and replaces that entry's models
(no `pi.unregisterProvider()` call required). The default export delegates to a named
`registerFromConfig(pi, configPath = CONFIG_PATH)` in `src/register.ts` so tests can target a temp
config; the export also accepts an optional second `configPath` parameter as a test seam.

### 6.3 Classify path (runtime)

Callers: codemode `models.classify(model, { state, questions })`, extensions
`ctx.modelRegistry.classify()`. pi dispatches by `model.api` → our registered
`classifiers["typesafe-systemone"]`, passing the model through **unchanged** (so `model.api`
stays our id). Our entry delegates to pi-ai's `classifySystemOne`, which issues
`POST {baseUrl}/v1/systemone` with `Authorization: Bearer <resolved apiKey>` and the
`ClassifierContext` body, and maps the response to `ClassifierResult` (probabilities per
question; token usage → `result.usage`, priced from cost metadata). Exact wire fields are pi-ai's
concern (`packages/ai/src/api/typesafe-system-one`). Failures propagate as normalized provider
errors; cancellation honors `options.signal`. `classify()` resolves rather than throws on provider
errors — callers must check `stopReason` / `errorMessage`.

**6.3.1 Transport (why we do not call `typesafeSystemOneApi()`).** `classifySystemOne` asserts
`model.api === transport.api` before doing any work. pi hands our custom model (api
`"typesafe-systemone"`) straight to our implementation, so pi-ai's stock transport — whose `api`
is `"typesafe-system-one"` — would fail every call. `src/register.ts` therefore defines:

```ts
const systemOneTransport: SystemOneTransport = {
  api: SUPPORTED_API, // "typesafe-systemone"
  label: "System One API",
  url: (model) => new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`),
  payload: (model, request) => ({ model: model.id, ...request }),
  output: (body) => {
    /* body must be a JSON object */
  },
};
```

This mirrors pi-ai's `typesafe-system-one` transport verbatim except for `api`, so the wire
protocol, retry policy, timeout handling, and usage pricing all remain pi-ai's responsibility.

## 7. Code Style

- TypeScript strict, ES modules, `.js` extensions in relative imports (NodeNext).
- Named exports for units; the extension entry has exactly one default export.
- No `any` — use pi-ai types (`ProviderConfig`, `ClassifierModel`, …) via `import type`.
- Errors: `throw new Error("<file>: <path>: <reason>")`; never log apiKeys, auth headers, or
  provider payloads (pi trust rule for provider extensions).

## 8. Project Structure

```text
pi-classifier-provider/
├── package.json        # name pi-classifier-provider, keywords:["pi-package"],
│                       #   pi: { extensions: ["./extensions/classifier-models.ts"] },
│                       #   peerDependencies: { "@earendil-works/pi-ai": "*" } (host-provided),
│                       #   devDependencies: typescript, @types/bun, pi-coding-agent (types only)
├── SPEC.md
├── README.md           # install (pi install ./…), config format, security note
├── extensions/
│   └── classifier-models.ts   # default export: load config → registerProvider per entry
├── src/
│   ├── config.ts       # read + validate classifier-models.json → ProviderEntry[]
│   └── register.ts     # map ProviderEntry[] → pi.registerProvider calls
└── test/
    ├── config.test.ts             # schema + fail-loud cases
    ├── register.test.ts           # baseUrl normalization, registration, idempotency, no-op
    └── classify.integration.test.ts  # mock /v1/systemone server end-to-end
```

Host-provided packages (`@earendil-works/pi-ai`) go in `peerDependencies` with `"*"` and are
never bundled. No runtime dependencies expected.

## 9. Development Workflow & Testing

Commands:

```bash
bun install
bun run typecheck     # tsc --noEmit
bun test              # unit + integration
pi -e . --list-models # smoke: registered classifier models appear (they never appear in /model)
```

Test plan (adapted from custom-provider.md's checklist, narrowest integration):

1. **config.test.ts** — valid sample (key redacted fixture) parses to `ProviderEntry[]`;
   `api: "llama-cpp-classify"` / missing `apiKey` / bad `baseUrl` / malformed JSON each throw
   with file path + field; missing file returns `null` (warn path).
2. **classify.integration.test.ts** — run the factory against a fake `pi` capturing
   `registerProvider` calls: one call per provider entry; each model mapped with `type:
   "classifier"`, `api`, `baseUrl` (= normalized root), `contextWindow`, `cost`;
   `classifiers["typesafe-systemone"]`
   present. Then stand up a local mock HTTP server as `baseUrl` and invoke its `classify`:
   assert method/URL `POST /v1/systemone`, `Authorization: Bearer <apiKey>`, and that a
   well-formed response (bool/choice/score answers + usage) maps to `ClassifierResult`
   probabilities and usage; assert a malformed answer and a 500 response each surface as a
   provider error (`stopReason: "error"`). This file is also the regression guard for §6.3.1:
   because it drives the model pi actually composes (`api: "typesafe-systemone"`), it fails
   with `"Unsupported classifier API"` if the registered entry stops accepting our own api id.
3. **register.test.ts** — `resolveBaseUrl` normalization cases, the mapping, registration
   idempotency on reload, missing-file warn + no-op, and that invalid config rejects.
3. **Manual smoke** (real config, real key, never committed): `pi -e .`, then
   `models.classify("sample/jev-latest", …)` from codemode — success criterion of §2.

Out of scope for testing (owned by pi-ai): retries, abort semantics, temperature, token pricing —
spot-check only.

## Open Questions

- OQ1 (RESOLVED, superseded): the Task 1 spike (`spike/classify-spike.ts`) verified that
  `typesafeSystemOneApi` from `@earendil-works/pi-ai/api/typesafe-system-one.lazy` returns
  `{ classify }`, and that auth reaches `Authorization: Bearer` only via `options.apiKey`
  (pi-injected; `model.apiKey` is ignored). The Task 6 integration test then showed that
  implementation is unusable behind a model whose `api` is our own id, so `src/register.ts` now
  calls `classifySystemOne` with the transport in §6.3.1. pi-ai's built-in api id remains
  `"typesafe-system-one"`; our config/registry id is `"typesafe-systemone"`, which is type-legal
  because `ClassifierApi` is an open union (`KnownClassifierApi | (string & {})`).
- OQ2: npm publish under a scope later? (keyword `pi-package` is set either way.)
