import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_PATH,
	SUPPORTED_API,
	loadConfig,
	type ModelEntry,
	type ProviderEntry,
} from "../src/config.js";

// Never touch the real user config: everything happens in a throwaway temp dir.
const FAKE_API_KEY = "test-key-not-real";
const tmpDir = mkdtempSync(join(tmpdir(), "pi-classifier-config-"));
const configFile = join(tmpDir, "classifier-models.json");

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

type JsonObject = Record<string, unknown>;

function obj(value: unknown): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("fixture accessor: expected an object");
	}
	return value as JsonObject;
}

function arrayOf(value: unknown): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error("fixture accessor: expected an array");
	}
	return value;
}

/** SPEC §6.1 sample shape, with an obviously fake key. */
function validConfig(): JsonObject {
	return {
		providers: {
			sample: {
				baseUrl: "https://api.typesafe.ai/v1",
				api: SUPPORTED_API,
				apiKey: FAKE_API_KEY,
				models: [
					{
						id: "jev-latest",
						name: "Jev latest",
						contextWindow: 64000,
						input: ["text"],
						cost: { input: 0.042, output: 0, cacheRead: 0.042, cacheWrite: 0 },
					},
				],
			},
		},
	};
}

function providerOf(config: JsonObject): JsonObject {
	return obj(obj(config.providers).sample);
}

function modelsOf(config: JsonObject): unknown[] {
	return arrayOf(providerOf(config).models);
}

function modelOf(config: JsonObject, index = 0): JsonObject {
	return obj(modelsOf(config)[index]);
}

function costOf(config: JsonObject, index = 0): JsonObject {
	return obj(modelOf(config, index).cost);
}

function writeRaw(value: unknown): void {
	writeFileSync(
		configFile,
		typeof value === "string" ? value : JSON.stringify(value),
		"utf8",
	);
}

async function load(value: unknown): Promise<ProviderEntry[] | null> {
	writeRaw(value);
	return loadConfig(configFile);
}

async function errorFrom(value: unknown): Promise<Error> {
	writeRaw(value);
	try {
		await loadConfig(configFile);
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected loadConfig to reject, but it resolved");
}

describe("config constants", () => {
	it("CONFIG_PATH points at ~/.pi/agent/classifier-models.json", () => {
		expect(CONFIG_PATH.endsWith(join(".pi", "agent", "classifier-models.json"))).toBe(
			true,
		);
	});

	it("SUPPORTED_API is our own custom provider api id", () => {
		expect(SUPPORTED_API).toBe("typesafe-systemone");
	});
});

describe("loadConfig valid input", () => {
	it("maps a valid fixture into ProviderEntry[]", async () => {
		const providers = await load(validConfig());

		const expectedModel: ModelEntry = {
			id: "jev-latest",
			name: "Jev latest",
			contextWindow: 64000,
			input: ["text"],
			cost: { input: 0.042, output: 0, cacheRead: 0.042, cacheWrite: 0 },
		};
		const expected: ProviderEntry[] = [
			{
				id: "sample",
				baseUrl: "https://api.typesafe.ai/v1",
				api: SUPPORTED_API,
				apiKey: FAKE_API_KEY,
				models: [expectedModel],
			},
		];

		expect(providers).toEqual(expected);
	});
});

describe("loadConfig missing file", () => {
	it("returns null when the file does not exist", async () => {
		const missing = join(tmpDir, "does-not-exist.json");
		expect(await loadConfig(missing)).toBeNull();
	});
});

describe("loadConfig malformed JSON", () => {
	it("throws with the config file path", async () => {
		const error = await errorFrom("{ nope");
		expect(error.message).toContain(configFile);
		expect(error.message.toLowerCase()).toContain("json");
	});
});

describe("loadConfig unsupported api", () => {
	it("rejects llama-cpp-classify naming the value and the provider id", async () => {
		const config = validConfig();
		providerOf(config).api = "llama-cpp-classify";
		const error = await errorFrom(config);
		expect(error.message).toContain("llama-cpp-classify");
		expect(error.message).toContain("sample");
	});

	it("rejects pi-ai's built-in hyphenated typesafe-system-one", async () => {
		const config = validConfig();
		providerOf(config).api = "typesafe-system-one";
		const error = await errorFrom(config);
		expect(error.message).toContain("typesafe-system-one");
		expect(error.message).toContain("sample");
		expect(error.message).toContain("typesafe-systemone");
	});
});

describe("loadConfig apiKey", () => {
	it("throws naming apiKey and the provider path when apiKey is missing", async () => {
		const config = validConfig();
		delete providerOf(config).apiKey;
		const error = await errorFrom(config);
		expect(error.message).toContain("providers.sample.apiKey");
	});

	it("throws naming apiKey when apiKey is empty", async () => {
		const config = validConfig();
		providerOf(config).apiKey = "";
		const error = await errorFrom(config);
		expect(error.message).toContain("providers.sample.apiKey");
	});
});

describe("loadConfig baseUrl", () => {
	for (const bad of ["not-a-url", "ftp://example.com"]) {
		it(`rejects baseUrl ${JSON.stringify(bad)} naming the field`, async () => {
			const config = validConfig();
			providerOf(config).baseUrl = bad;
			const error = await errorFrom(config);
			expect(error.message).toContain("baseUrl");
		});
	}
});

describe("loadConfig models array", () => {
	it("rejects an empty models array naming the field", async () => {
		const config = validConfig();
		providerOf(config).models = [];
		const error = await errorFrom(config);
		expect(error.message).toContain("providers.sample.models");
	});
});

describe("loadConfig input", () => {
	it("rejects an unknown input kind naming the indexed path", async () => {
		const config = validConfig();
		modelOf(config).input = ["txt"];
		const error = await errorFrom(config);
		expect(error.message).toContain("models[0].input[0]");
		expect(error.message).toContain("txt");
	});
});

describe("loadConfig contextWindow", () => {
	for (const bad of [0, -1, 1.5, "64000"]) {
		it(`rejects contextWindow ${JSON.stringify(bad)} naming the indexed model path`, async () => {
			const config = validConfig();
			modelOf(config).contextWindow = bad;
			const error = await errorFrom(config);
			expect(error.message).toContain("models[0].contextWindow");
		});
	}
});

describe("loadConfig cost", () => {
	it("rejects a cost missing a field naming the exact cost field path", async () => {
		const config = validConfig();
		delete costOf(config).output;
		const error = await errorFrom(config);
		expect(error.message).toContain("models[0].cost.output");
	});

	it("rejects a non-numeric cost field naming the exact cost field path", async () => {
		const config = validConfig();
		costOf(config).cacheRead = "expensive";
		const error = await errorFrom(config);
		expect(error.message).toContain("models[0].cost.cacheRead");
	});
});

describe("loadConfig secret hygiene", () => {
	it("never includes the apiKey value in error messages", async () => {
		const badApi = validConfig();
		providerOf(badApi).api = "llama-cpp-classify";

		const badModels = validConfig();
		providerOf(badModels).models = [];

		const badContext = validConfig();
		modelOf(badContext).contextWindow = 0;

		const badCost = validConfig();
		delete costOf(badCost).input;

		for (const config of [badApi, badModels, badContext, badCost]) {
			const error = await errorFrom(config);
			expect(error.message).not.toContain(FAKE_API_KEY);
		}
	});
});
