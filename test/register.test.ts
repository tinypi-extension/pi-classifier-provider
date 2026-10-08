import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { SUPPORTED_API, type ProviderEntry } from "../src/config.js";
import {
	registerFromConfig,
	registerProviders,
	resolveBaseUrl,
	type ProviderRegistrationHost,
} from "../src/register.js";
import * as extensionModule from "../extensions/classifier-models.js";

// Never touch the real user config: everything happens in a throwaway temp dir.
const FAKE_API_KEY = "test-key-not-real";
const FAKE_API_KEY_2 = "test-key-not-real-2";

const tmpDir = mkdtempSync(join(tmpdir(), "pi-classifier-register-"));
const validConfigFile = join(tmpDir, "valid.json");
const invalidConfigFile = join(tmpDir, "invalid-api.json");
const missingConfigFile = join(tmpDir, "missing.json");

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/** A two-provider fixture with obviously fake keys (SPEC §5 shape). */
function fixtureEntries(): ProviderEntry[] {
	return [
		{
			id: "sample",
			baseUrl: "https://api.typesafe.ai",
			api: SUPPORTED_API,
			apiKey: FAKE_API_KEY,
			models: [
				{
					id: "jev-latest",
					name: "Jev latest",
					contextWindow: 64000,
					input: ["text"],
					cost: {
						input: 0.042,
						output: 0,
						cacheRead: 0.042,
						cacheWrite: 0,
					},
				},
			],
		},
		{
			id: "second",
			baseUrl: "https://second.example/v1",
			api: SUPPORTED_API,
			apiKey: FAKE_API_KEY_2,
			models: [
				{
					id: "m1",
					name: "M one",
					contextWindow: 8000,
					input: ["text", "image"],
					cost: {
						input: 1.5,
						output: 2.5,
						cacheRead: 0.5,
						cacheWrite: 0.25,
					},
				},
				{
					id: "m2",
					name: "M two",
					contextWindow: 16000,
					input: ["image"],
					cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 },
				},
			],
		},
	];
}

/** The JSON form of `fixtureEntries()`. */
function fixtureConfigJson(): unknown {
	const providers: Record<string, unknown> = {};
	for (const entry of fixtureEntries()) {
		providers[entry.id] = {
			baseUrl: entry.baseUrl,
			api: entry.api,
			apiKey: entry.apiKey,
			models: entry.models,
		};
	}
	return { providers };
}

function createFakePi() {
	const registrations = new Map<string, ProviderConfig>();
	const calls: string[] = [];
	const unregisterCalls: string[] = [];
	return {
		registrations,
		calls,
		unregisterCalls,
		registerProvider(name: string, config: ProviderConfig) {
			calls.push(name);
			registrations.set(name, config);
		},
		unregisterProvider(name: string) {
			unregisterCalls.push(name);
			registrations.delete(name);
		},
	};
}

type FakePi = ReturnType<typeof createFakePi>;

function asHost(fake: FakePi): ProviderRegistrationHost {
	return fake;
}

function writeConfig(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value), "utf8");
}

// Write the config files once, before the tests run.
writeConfig(validConfigFile, fixtureConfigJson());
const invalidConfig = fixtureConfigJson() as {
	providers: { sample: { api: string }; second: { api: string } };
};
invalidConfig.providers.sample.api = "llama-cpp-classify";
writeConfig(invalidConfigFile, invalidConfig);

describe("resolveBaseUrl", () => {
	it("appends /v1 to a bare root", () => {
		expect(resolveBaseUrl("https://api.typesafe.ai")).toBe(
			"https://api.typesafe.ai/v1",
		);
	});

	it("trims a trailing slash before appending /v1", () => {
		expect(resolveBaseUrl("https://api.typesafe.ai/")).toBe(
			"https://api.typesafe.ai/v1",
		);
	});

	it("leaves an existing /v1 unchanged", () => {
		expect(resolveBaseUrl("https://api.typesafe.ai/v1")).toBe(
			"https://api.typesafe.ai/v1",
		);
	});

	it("trims trailing slashes from an existing /v1", () => {
		expect(resolveBaseUrl("https://api.typesafe.ai/v1/")).toBe(
			"https://api.typesafe.ai/v1",
		);
	});

	it("appends /v1 to a root that carries a path", () => {
		expect(resolveBaseUrl("https://x.example/api")).toBe(
			"https://x.example/api/v1",
		);
	});
});

describe("registerProviders", () => {
	it("calls registerProvider once per entry, named by the config key", () => {
		const fake = createFakePi();
		const entries = fixtureEntries();
		registerProviders(asHost(fake), entries);

		expect(fake.calls).toEqual(entries.map((entry) => entry.id));
		expect(fake.registrations.size).toBe(entries.length);
	});

	it("passes apiKey through verbatim per provider", () => {
		const fake = createFakePi();
		registerProviders(asHost(fake), fixtureEntries());

		expect(fake.registrations.get("sample")?.apiKey).toBe(FAKE_API_KEY);
		expect(fake.registrations.get("second")?.apiKey).toBe(FAKE_API_KEY_2);
	});

	it.each(fixtureEntries())("maps $id models to full classifier configs", (entry) => {
		const fake = createFakePi();
		registerProviders(asHost(fake), fixtureEntries());
		const config = fake.registrations.get(entry.id);
		if (config === undefined) {
			throw new Error(`no registration for provider ${entry.id}`);
		}

		const expectedModels: NonNullable<ProviderConfig["models"]> = entry.models.map(
			(model) => ({
			type: "classifier",
			api: SUPPORTED_API,
			baseUrl: resolveBaseUrl(entry.baseUrl),
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			input: model.input,
			cost: model.cost,
		}));
		expect(config.models).toEqual(expectedModels);
	});

	it("registers the classifier under exactly SUPPORTED_API with a classify function", () => {
		const fake = createFakePi();
		registerProviders(asHost(fake), fixtureEntries());

		const config = fake.registrations.get("sample");
		if (config === undefined) {
			throw new Error("no registration for provider sample");
		}
		const classifiers = config.classifiers;
		if (classifiers === undefined) {
			throw new Error("registration has no classifiers");
		}

		expect(Object.keys(classifiers)).toEqual([SUPPORTED_API]);
		expect(typeof classifiers[SUPPORTED_API]?.classify).toBe("function");
	});

	it("is idempotent when invoked twice and never calls unregisterProvider", () => {
		const fake = createFakePi();
		const entries = fixtureEntries();

		registerProviders(asHost(fake), entries);
		registerProviders(asHost(fake), entries);

		expect(fake.registrations.size).toBe(entries.length);
		expect(fake.unregisterCalls).toEqual([]);
		// The second call replaced the entry's models, it did not concatenate them.
		expect(fake.registrations.get("second")?.models).toHaveLength(
			entries[1]?.models.length ?? 0,
		);
	});
});

describe("registerFromConfig", () => {
	it("registers providers from a valid temp config file", async () => {
		const fake = createFakePi();
		await registerFromConfig(asHost(fake), validConfigFile);

		expect(fake.calls).toEqual(["sample", "second"]);
		expect(fake.registrations.size).toBe(2);
	});

	it("warns once and registers nothing for a missing config file", async () => {
		const fake = createFakePi();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			await registerFromConfig(asHost(fake), missingConfigFile);

			expect(fake.registrations.size).toBe(0);
			expect(fake.calls).toEqual([]);
			expect(warn).toHaveBeenCalledTimes(1);
			const message = warn.mock.calls[0]?.[0];
			expect(String(message)).toContain(missingConfigFile);
			expect(String(message).toLowerCase()).toContain("disabled");
		} finally {
			warn.mockRestore();
		}
	});

	it("rejects an unsupported api naming the config path and field", async () => {
		const fake = createFakePi();
		let error: Error | null = null;
		try {
			await registerFromConfig(asHost(fake), invalidConfigFile);
		} catch (caught) {
			error = caught as Error;
		}

		expect(error).not.toBeNull();
		expect(error?.message).toContain(invalidConfigFile);
		expect(error?.message).toContain("providers.sample.api");
		expect(fake.registrations.size).toBe(0);
	});
});

describe("extension entry", () => {
	it("has exactly one default export that is a function", () => {
		expect(typeof extensionModule.default).toBe("function");
		expect(Object.keys(extensionModule)).toEqual(["default"]);
	});

	it("registers entries from the provided temp config via the test seam", async () => {
		const fake = createFakePi();
		await extensionModule.default(
			asHost(fake) as unknown as Parameters<typeof extensionModule.default>[0],
			validConfigFile,
		);

		expect(fake.calls).toEqual(["sample", "second"]);
		expect(fake.registrations.size).toBe(2);
	});
});
