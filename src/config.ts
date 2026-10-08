import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default location of the classifier model config file. */
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "classifier-models.json");

/**
 * The only classifier `api` id accepted in classifier-models.json.
 *
 * This is our own custom provider's api id (no hyphen between "system" and "one"),
 * which is the value the user's classifier-models.json uses. It is deliberately
 * different from pi-ai's built-in `typesafe-system-one` id. The extension registers
 * its classifier implementation under `classifiers[SUPPORTED_API]`, so the config
 * value MUST match exactly; every other api id is rejected loudly.
 */
export const SUPPORTED_API = "typesafe-systemone";

/** Allowed model input kinds, matching pi-ai `BaseModel.input`. */
export type ModelInputKind = "text" | "image";

/** A model entry inside `providers.<id>.models[]` (SPEC §5). */
export interface ModelEntry {
	id: string;
	name: string;
	contextWindow: number;
	input: ModelInputKind[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

/** A provider entry: `providers.<id>` (SPEC §5). `id` is filled from the config key. */
export interface ProviderEntry {
	id: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	models: ModelEntry[];
}

const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type CostField = (typeof COST_FIELDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isInputKind(value: unknown): value is ModelInputKind {
	return value === "text" || value === "image";
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isErrnoException(error: unknown): error is { code: string } {
	return isRecord(error) && typeof error.code === "string";
}

function throwConfigError(configPath: string, jsonPath: string, reason: string): never {
	throw new Error(`${configPath}: ${jsonPath}: ${reason}`);
}

function parseAbsoluteHttpUrl(value: string): URL | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return null;
	}
	return url;
}

function parseProvider(configPath: string, providerId: string, value: unknown): ProviderEntry {
	const base = `providers.${providerId}`;

	if (!isRecord(value)) {
		throwConfigError(configPath, base, "must be an object");
	}

	const baseUrl = value.baseUrl;
	if (typeof baseUrl !== "string") {
		throwConfigError(configPath, `${base}.baseUrl`, "must be a string");
	}
	if (parseAbsoluteHttpUrl(baseUrl) === null) {
		throwConfigError(
			configPath,
			`${base}.baseUrl`,
			`must be an absolute http(s) URL, got "${baseUrl}"`,
		);
	}

	const api = value.api;
	if (!isNonEmptyString(api)) {
		throwConfigError(configPath, `${base}.api`, "must be a non-empty string");
	}
	if (api !== SUPPORTED_API) {
		throwConfigError(
			configPath,
			`${base}.api`,
			`Unsupported api "${api}" for provider "${providerId}"; expected "${SUPPORTED_API}"`,
		);
	}

	const apiKey = value.apiKey;
	if (!isNonEmptyString(apiKey)) {
		throwConfigError(configPath, `${base}.apiKey`, "must be a non-empty string");
	}

	const models = value.models;
	if (!Array.isArray(models) || models.length === 0) {
		throwConfigError(configPath, `${base}.models`, "must be a non-empty array");
	}

	const parsedModels: ModelEntry[] = [];
	for (let index = 0; index < models.length; index += 1) {
		parsedModels.push(parseModel(configPath, `${base}.models[${index}]`, models[index]));
	}

	return { id: providerId, baseUrl, api, apiKey, models: parsedModels };
}

function parseModel(configPath: string, base: string, value: unknown): ModelEntry {
	if (!isRecord(value)) {
		throwConfigError(configPath, base, "must be an object");
	}

	const id = value.id;
	if (!isNonEmptyString(id)) {
		throwConfigError(configPath, `${base}.id`, "must be a non-empty string");
	}

	const name = value.name;
	if (!isNonEmptyString(name)) {
		throwConfigError(configPath, `${base}.name`, "must be a non-empty string");
	}

	const contextWindow = value.contextWindow;
	if (!isPositiveInteger(contextWindow)) {
		throwConfigError(configPath, `${base}.contextWindow`, "must be a positive integer");
	}

	const input = value.input;
	if (!Array.isArray(input) || input.length === 0) {
		throwConfigError(configPath, `${base}.input`, "must be a non-empty array of strings");
	}
	const parsedInput: ModelInputKind[] = [];
	for (let index = 0; index < input.length; index += 1) {
		const item = input[index];
		if (!isInputKind(item)) {
			throwConfigError(
				configPath,
				`${base}.input[${index}]`,
				`must be "text" or "image", got ${JSON.stringify(item) ?? "undefined"}`,
			);
		}
		parsedInput.push(item);
	}

	const cost = value.cost;
	if (!isRecord(cost)) {
		throwConfigError(configPath, `${base}.cost`, "must be an object");
	}

	const parsedCost: ModelEntry["cost"] = {
		input: parseCostField(configPath, `${base}.cost`, cost, "input"),
		output: parseCostField(configPath, `${base}.cost`, cost, "output"),
		cacheRead: parseCostField(configPath, `${base}.cost`, cost, "cacheRead"),
		cacheWrite: parseCostField(configPath, `${base}.cost`, cost, "cacheWrite"),
	};

	return { id, name, contextWindow, input: parsedInput, cost: parsedCost };
}

function parseCostField(
	configPath: string,
	base: string,
	cost: Record<string, unknown>,
	field: CostField,
): number {
	const value = cost[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throwConfigError(configPath, `${base}.${field}`, "must be a finite number");
	}
	return value;
}

/**
 * Read and validate the classifier model config (SPEC §6.1).
 *
 * - Missing file → `null` (the caller warns and no-ops).
 * - Any other read error, malformed JSON, or schema violation → throws
 *   `${configPath}: ${jsonPath}: ${reason}`. Never includes the apiKey value.
 */
export async function loadConfig(
	configPath: string = CONFIG_PATH,
): Promise<ProviderEntry[] | null> {
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") {
			return null;
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "invalid JSON";
		throwConfigError(configPath, "$", `invalid JSON: ${reason}`);
	}

	if (!isRecord(parsed)) {
		throwConfigError(configPath, "$", "root must be a JSON object");
	}

	const providers = parsed.providers;
	if (!isRecord(providers)) {
		throwConfigError(configPath, "providers", "must be an object");
	}

	const providerIds = Object.keys(providers);
	if (providerIds.length === 0) {
		throwConfigError(configPath, "providers", "must contain at least one provider");
	}

	const entries: ProviderEntry[] = [];
	for (const providerId of providerIds) {
		entries.push(parseProvider(configPath, providerId, providers[providerId]));
	}
	return entries;
}
