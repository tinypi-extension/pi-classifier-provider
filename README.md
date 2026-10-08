# pi-classifier-provider

A pi package that exposes [TypeSafe System One](https://api.typesafe.ai) **classifier** models
declared in `~/.pi/agent/classifier-models.json` as pi classifier models. A provider extension
reads that file and calls `pi.registerProvider()` once per entry, so you can point pi at several
TypeSafe endpoints and keys without hand-editing provider config. The registered models are then
usable with `classify()` (from codemode or extension code) rather than the interactive model
picker.

## Install

Run from the directory that contains this package (the repo directory name may differ from
`pi-classifier-provider`):

```bash
pi install git:github.com/tinypi-extension/pi-classifier-provider
```

To run the package ad hoc during local development, without installing it:

```bash
pi -e git:github.com/tinypi-extension/pi-classifier-provider
```

## Configuration

The config path is fixed at `~/.pi/agent/classifier-models.json`; there is no environment
override in v1. The file uses the same `providers` nesting as `models.json`:

```json
{
  "providers": {
    "sample": {
      "baseUrl": "https://api.typesafe.ai",
      "api": "typesafe-systemone",
      "apiKey": "$TYPESAFE_API_KEY",
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

The `apiKey` above is intentionally redacted to a `$VAR` reference. Never commit a real key.

### Provider fields (`providers.<id>`)

| Field | Required | Description |
| --- | --- | --- |
| `<id>` (the object key) | yes | Provider name. Models are exposed as `<id>/<model-id>`. |
| `baseUrl` | yes | API **root**, an absolute `http(s)` URL, e.g. `https://api.typesafe.ai`. |
| `api` | yes | Must be exactly `typesafe-systemone`. Every other value is rejected. |
| `apiKey` | yes | Non-empty key, passed verbatim to pi (interpolation below). |
| `models` | yes | Non-empty array of model entries. |

### Model fields (`providers.<id>.models[]`)

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Model id. The full model id is `<provider>/<id>`. |
| `name` | yes | Display name. |
| `contextWindow` | yes | Positive integer. |
| `input` | yes | Non-empty array of `"text"` and/or `"image"`. |
| `cost.input` | yes | Finite number. |
| `cost.output` | yes | Finite number. |
| `cost.cacheRead` | yes | Finite number. |
| `cost.cacheWrite` | yes | Finite number. |

`api` must be exactly `typesafe-systemone` — no hyphen between `system` and `one`. This is this
package's own classifier api id, and it is also the id under which the classifier implementation
is registered. Any other value is rejected at validation time.

### `baseUrl` normalization

`baseUrl` is the API root. The package strips trailing slashes and appends `/v1` unless the path
already ends in `/v1`, so both `https://api.typesafe.ai` and `https://api.typesafe.ai/v1` work.
Requests go to `POST {root}/v1/systemone` with `Authorization: Bearer <resolved apiKey>`.

## Usage

Each `providers.<id>` entry registers one pi provider; the config key becomes the provider name,
and each model appears as `<provider>/<model-id>` — for the sample above, `sample/jev-latest`.
Classifier models are used through `classify()` (codemode, or the model registry from an
extension). They never appear in the interactive `/model` picker.

Codemode example:

```js
const jev = await models.getModelOfType("classifier", "sample", "jev-latest");

const result = await models.classify(jev, {
  state: { message: "The export button did nothing." },
  questions: {
    sentiment: {
      type: "choice",
      instructions: "How does the user feel about the product?",
      criteria: { positive: "Satisfied", negative: "Frustrated", neutral: "Neither" },
    },
  },
});

if (result.stopReason === "stop") {
  return {
    probabilities: result.answers.sentiment.probabilities,
    usage: result.usage,
  };
}
return { error: result.errorMessage };
```

`classify()` does not throw on provider errors; check `result.stopReason` and `result.errorMessage`.

## Error behavior

- **Missing config file:** the extension logs a `console.warn` and registers nothing. pi still
  starts.
- **Malformed JSON or any schema violation:** the extension throws
  `Error("<config file>: <json path>: <reason>")`, naming the offending field path. pi surfaces
  the error.

Example:

```
/Users/you/.pi/agent/classifier-models.json: providers.sample.api: Unsupported api "llama-cpp-classify" for provider "sample"; expected "typesafe-systemone"
```

## Security

- Never commit a real API key. Prefer an environment-variable reference such as
  `$TYPESAFE_API_KEY`, or a `!command` that prints the key.
- `apiKey` values are passed verbatim to pi, which applies its normal interpolation: `$NAME` and
  `${NAME}` read environment variables, a leading `!command` uses command output, and `$$` emits
  a literal `$`.
- The extension never logs keys, auth headers, or provider payloads.
- Provider extensions are trusted code: installing a pi package runs the code it ships.

## Development

```bash
bun install
bun run typecheck     # tsc --noEmit
bun test              # unit + integration tests
pi -e . --list-models # smoke: registered classifier models appear
```

Project layout:

```text
extensions/classifier-models.ts  # default export: load config → pi.registerProvider per entry
src/config.ts                    # read + validate classifier-models.json → ProviderEntry[]
src/register.ts                  # map ProviderEntry[] → pi.registerProvider calls
test/                            # unit + integration tests
```

`@earendil-works/pi-ai` is a host-provided peer dependency; `@earendil-works/pi-coding-agent` is
a devDependency used for types only.
