import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ClassifierApi,
	ClassifierBoolQuestion,
	ClassifierChoiceQuestion,
	ClassifierContext,
	ClassifierModel,
	ClassifierOptions,
	ClassifierResult,
	ClassifierScoreQuestion,
	ProviderClassifier,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { SUPPORTED_API } from "../src/config.js";
import classifierModels from "../extensions/classifier-models.js";

// Never touch the real user config or key: everything happens against a local mock.
const FAKE_API_KEY = "test-key-not-real";

interface CapturedRequest {
	method: string;
	pathname: string;
	headers: Record<string, string>;
	body: unknown;
}

const requests: CapturedRequest[] = [];

/** Replies with a well-formed System One response unless a test swaps it. */
let respond: () => Response = () =>
	Response.json({
		answers: {
			is_urgent: { type: "noul", noul: 0.87 },
			sentiment: {
				type: "choice",
				choice: "positive",
				probabilities: { positive: 0.7, negative: 0.1, neutral: 0.2 },
				confidence: 0.91,
			},
			quality: { type: "score", score: 4, confidence: 0.64 },
		},
		usage: { input_tokens: 123, output_tokens: 7 },
	});

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		const body: unknown = await req.json().catch(() => null);
		requests.push({
			method: req.method,
			pathname: url.pathname,
			headers: Object.fromEntries(req.headers.entries()),
			body,
		});
		return respond();
	},
});

const tmpDir = mkdtempSync(join(tmpdir(), "pi-classifier-integration-"));
const configPath = join(tmpDir, "classifier-models.json");

writeFileSync(
	configPath,
	JSON.stringify({
		providers: {
			sample: {
				// API root with no /v1: resolveBaseUrl must add it end-to-end.
				baseUrl: `http://127.0.0.1:${server.port}`,
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
	}),
	"utf8",
);

function createFakePi() {
	const registrations = new Map<string, ProviderConfig>();
	return {
		registrations,
		registerProvider(name: string, config: ProviderConfig): void {
			registrations.set(name, config);
		},
		unregisterProvider(name: string): void {
			registrations.delete(name);
		},
	};
}

const fakePi = createFakePi();
let registered: ProviderConfig | undefined;
let classifier: ProviderClassifier | undefined;

beforeAll(async () => {
	await classifierModels(
		fakePi as unknown as Parameters<typeof classifierModels>[0],
		configPath,
	);
	registered = fakePi.registrations.get("sample");
	classifier = registered?.classifiers?.[SUPPORTED_API];
});

afterAll(() => {
	server.stop(true);
	rmSync(tmpDir, { recursive: true, force: true });
});

const STATE = { message: "hello world", meta: { source: "integration" } };

const boolQuestion: ClassifierBoolQuestion = {
	type: "bool",
	instructions: "Is this urgent?",
	criteria: { true: "urgent", false: "not urgent" },
};
const choiceQuestion: ClassifierChoiceQuestion = {
	type: "choice",
	instructions: "Pick the sentiment.",
	criteria: { positive: "good", negative: "bad", neutral: "meh" },
};
const scoreQuestion: ClassifierScoreQuestion = {
	type: "score",
	instructions: "Score quality 1-5.",
	criteria: ["low", "high"],
};

const context: ClassifierContext = {
	state: STATE,
	questions: {
		is_urgent: boolQuestion,
		sentiment: choiceQuestion,
		quality: scoreQuestion,
	},
};

function getClassifier(): ProviderClassifier {
	if (classifier === undefined) {
		throw new Error(`no classifier registered under "${SUPPORTED_API}"`);
	}
	return classifier;
}

function buildModel(): ClassifierModel<ClassifierApi> {
	const model = registered?.models?.[0];
	if (model === undefined) {
		throw new Error("no model was registered");
	}
	// pi composes the runtime model with the provider id; `models[0]` is the loose
	// `ProviderModelConfig` union, so narrow it to the strict `ClassifierModel` shape.
	return { ...model, provider: "sample" } as unknown as ClassifierModel<ClassifierApi>;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected an object");
	}
	return value as Record<string, unknown>;
}

function firstRequest(): CapturedRequest {
	const request = requests[0];
	if (request === undefined) {
		throw new Error("expected the mock server to receive a request");
	}
	return request;
}

describe("classifier integration over a real HTTP mock", () => {
	it("posts normalized requests and maps a full bool/choice/score response", async () => {
		requests.length = 0;
		respond = () =>
			Response.json({
				answers: {
					is_urgent: { type: "noul", noul: 0.87 },
					sentiment: {
						type: "choice",
						choice: "positive",
						probabilities: { positive: 0.7, negative: 0.1, neutral: 0.2 },
						confidence: 0.91,
					},
					quality: { type: "score", score: 4, confidence: 0.64 },
				},
				usage: { input_tokens: 123, output_tokens: 7 },
			});

		const model = buildModel();
		// Regression guard for the Part A bug: pi dispatches by `model.api` and our
		// transport must speak that exact id.
		expect(model.api).toBe(SUPPORTED_API);

		const result = await getClassifier().classify(model, context, {
			apiKey: FAKE_API_KEY,
		});

		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");

		// --- the wire request -------------------------------------------------
		expect(requests).toHaveLength(1);
		const request = firstRequest();
		expect(request.method).toBe("POST");
		// The API root had no /v1; this proves baseUrl normalization end-to-end.
		expect(request.pathname).toBe("/v1/systemone");
		expect(request.headers.authorization).toBe(`Bearer ${FAKE_API_KEY}`);
		expect(request.headers["content-type"]).toBe("application/json");

		const body = asRecord(request.body);
		expect(body.model).toBe("jev-latest");
		expect(body.state).toEqual(STATE);

		const questions = asRecord(body.questions);
		// bool is rewritten to the wire type `noul`; choice/score pass through as-is.
		expect(questions.is_urgent).toEqual({ ...boolQuestion, type: "noul" });
		expect(questions.sentiment).toEqual(choiceQuestion);
		expect(questions.quality).toEqual(scoreQuestion);

		// --- the mapped result ------------------------------------------------
		expect(result.api).toBe(SUPPORTED_API);
		expect(result.provider).toBe("sample");
		expect(result.model).toBe("jev-latest");
		expect(result.answers).toEqual({
			is_urgent: { type: "bool", probability: 0.87 },
			sentiment: {
				type: "choice",
				choice: "positive",
				probabilities: { positive: 0.7, negative: 0.1, neutral: 0.2 },
				confidence: 0.91,
			},
			quality: { type: "score", score: 4, confidence: 0.64 },
		});
		expect(result.usage?.input).toBe(123);
		expect(result.usage?.output).toBe(7);
		expect(result.usage?.totalTokens).toBe(130);
		// Cost is computed from the model cost table: assert finiteness, not a rounded value.
		expect(Number.isFinite(result.usage?.cost.total)).toBe(true);
		expect(result.usage?.cost.total).toBeGreaterThanOrEqual(0);
	});

	it("normalizes a malformed answer into an error mention of the question id", async () => {
		requests.length = 0;
		// A choice question answered with a wire `noul` value is invalid. Usage is
		// still present because the request was billed before parsing answers failed.
		respond = () =>
			Response.json({
				answers: {
					is_urgent: { type: "noul", noul: 0.5 },
					sentiment: { type: "noul", noul: 1 },
					quality: { type: "score", score: 3, confidence: 0.5 },
				},
				usage: { input_tokens: 10, output_tokens: 2 },
			});

		const result: ClassifierResult = await getClassifier().classify(
			buildModel(),
			context,
			{ apiKey: FAKE_API_KEY },
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("sentiment");
		// The server still received the request that produced the bad answers.
		expect(requests).toHaveLength(1);
		expect(result.usage?.input).toBe(10);
		expect(result.usage?.output).toBe(2);
	});

	it("resolves (does not throw) on HTTP 500 and issues one request with maxRetries: 0", async () => {
		requests.length = 0;
		respond = () => new Response("boom", { status: 500 });

		const options: ClassifierOptions = {
			apiKey: FAKE_API_KEY,
			// ClassifierOptions extends ProviderRequestOptions, which carries maxRetries.
			maxRetries: 0,
		};
		const result = await getClassifier().classify(buildModel(), context, options);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("500");
		expect(result.errorMessage).toContain("System One API");
		// maxRetries: 0 means no backoff retries against the mock.
		expect(requests).toHaveLength(1);
	});
});
