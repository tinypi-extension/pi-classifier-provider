import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	classifySystemOne,
	type SystemOneTransport,
} from "@earendil-works/pi-ai/api/system-one-shared";
import { CONFIG_PATH, SUPPORTED_API, loadConfig, type ProviderEntry } from "./config.js";

/**
 * pi-ai's built-in `typesafe-system-one` transport rejects any model whose `api`
 * differs from its own id, but pi dispatches classifiers by `model.api` and our
 * models carry our own `SUPPORTED_API` id. So we reuse pi-ai's System One wire
 * logic (`classifySystemOne`) with a transport that speaks our id.
 */
const systemOneTransport: SystemOneTransport = {
	api: SUPPORTED_API,
	label: "System One API",
	url: (model) => new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, request) => ({ model: model.id, ...request }),
	output: (body) => {
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			throw new Error("System One API returned an unexpected response");
		}
		return body as Record<string, unknown>;
	},
};

/**
 * The minimal slice of `ExtensionAPI` that registration needs. `ExtensionAPI` is
 * structurally assignable to this, and tests can pass a small fake host.
 */
export interface ProviderRegistrationHost {
	registerProvider(name: string, config: ProviderConfig): void;
	unregisterProvider(name: string): void;
}

/**
 * Normalize a config `baseUrl` (the API root) into the URL pi-ai expects.
 *
 * pi-ai's `typesafe-system-one` transport builds `{baseUrl}/systemone` and never
 * adds `/v1`, so we strip trailing slashes and append `/v1` unless the path
 * already ends in `/v1` (SPEC §6.2.1).
 */
export function resolveBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Register one pi provider per config entry (SPEC §6.2).
 *
 * `apiKey` is passed verbatim so pi can apply `$VAR` / `${VAR}` / `!cmd`
 * interpolation. Idempotent on `/reload`: `registerProvider` is keyed by
 * provider name and replaces that entry's models, so no `unregisterProvider`
 * call is needed.
 */
export function registerProviders(
	pi: ProviderRegistrationHost,
	entries: ProviderEntry[],
): void {
	for (const entry of entries) {
		const config: ProviderConfig = {
			apiKey: entry.apiKey,
			models: entry.models.map((model) => ({
				type: "classifier",
				api: SUPPORTED_API,
				baseUrl: resolveBaseUrl(entry.baseUrl),
				id: model.id,
				name: model.name,
				contextWindow: model.contextWindow,
				input: model.input,
				cost: model.cost,
			})),
			classifiers: {
				[SUPPORTED_API]: {
					classify: (model, context, options) =>
						classifySystemOne(systemOneTransport, model, context, options),
				},
			},
		};
		pi.registerProvider(entry.id, config);
	}
}

/**
 * Load the config and register its providers.
 *
 * Missing file → warn once and no-op (pi keeps starting). Validation errors
 * propagate unchanged (they already carry `"<file>: <path>: <reason>"`).
 */
export async function registerFromConfig(
	pi: ProviderRegistrationHost,
	configPath: string = CONFIG_PATH,
): Promise<void> {
	const entries = await loadConfig(configPath);
	if (entries === null) {
		console.warn(`Classifier models disabled: no config file at ${configPath}`);
		return;
	}
	registerProviders(pi, entries);
}
