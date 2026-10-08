/**
 * Task 1 spike — prove pi-ai's built-in `typesafe-system-one` classifier API
 * behaves as expected OUTSIDE the pi runtime.
 *
 * Run: cd /Users/tinyphat/Project/pi-classifier-provider && bun run spike/classify-spike.ts
 *
 * Disposable. Never touches the real API key.
 */
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import type {
	ClassifierContext,
	ClassifierModel,
	ClassifierApi,
	ClassifierResult,
	ClassifierFunction,
	ProviderClassifier,
} from "@earendil-works/pi-ai";

const FAKE_KEY = "spike-fake-key";

interface Observed {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
}

const observed: Observed[] = [];

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0, // ephemeral
	async fetch(req) {
		const url = new URL(req.url);
		const body = await req.json().catch(() => null);
		observed.push({
			method: req.method,
			path: url.pathname,
			headers: Object.fromEntries(req.headers.entries()),
			body,
		});
		// Well-formed System One response: bool -> noul, plus choice, score, usage.
		return Response.json({
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
	},
});

const port = server.port;
const baseUrlNoV1 = `http://127.0.0.1:${port}`;
const baseUrlV1 = `http://127.0.0.1:${port}/v1`;

function makeModel(baseUrl: string): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		api: "typesafe-system-one",
		provider: "spike",
		id: "jev-latest",
		name: "Jev latest",
		baseUrl,
		contextWindow: 64000,
		input: ["text"],
		cost: { input: 0.042, output: 0, cacheRead: 0.042, cacheWrite: 0 },
	};
}

const context: ClassifierContext = {
	state: { message: "hello world" },
	questions: {
		is_urgent: {
			type: "bool",
			instructions: "Is this urgent?",
			criteria: { true: "urgent", false: "not urgent" },
		},
		sentiment: {
			type: "choice",
			instructions: "Pick the sentiment.",
			criteria: { positive: "good", negative: "bad", neutral: "meh" },
		},
		quality: {
			type: "score",
			instructions: "Score quality 1-5.",
			criteria: ["low", "high"],
		},
	},
};

const api = typesafeSystemOneApi();

// (a) Does the lazy factory satisfy ProviderClassifier? Check at runtime shape.
const classifier: ProviderClassifier = api;
const classifyFn: ClassifierFunction = api.classify;

console.log("=== import shape ===");
console.log("typesafeSystemOneApi() keys:", Object.keys(api));
console.log("classify type:", typeof api.classify);
console.log("ProviderClassifier assignable (runtime):", typeof classifier.classify === "function");
void classifyFn;

console.log("\n=== empty-options (no apiKey) error path ===");
const noKey = await api.classify(makeModel(baseUrlNoV1), context, {} as never);
console.log("stopReason:", noKey.stopReason, "| errorMessage:", noKey.errorMessage);

console.log("\n=== model.apiKey is NOT read (only options.apiKey) ===");
const modelWithKey = makeModel(baseUrlNoV1) as ClassifierModel<ClassifierApi> & { apiKey?: string };
modelWithKey.apiKey = FAKE_KEY;
const modelKeyOnly = await api.classify(modelWithKey, context, {} as never);
console.log("stopReason:", modelKeyOnly.stopReason, "| errorMessage:", modelKeyOnly.errorMessage);

console.log("\n=== api id mismatch (config uses 'typesafe-systemone') ===");
const wrongApi = { ...makeModel(baseUrlNoV1), api: "typesafe-systemone" } as ClassifierModel<ClassifierApi>;
const wrongApiResult = await api.classify(wrongApi, context, { apiKey: FAKE_KEY });
console.log("stopReason:", wrongApiResult.stopReason, "| errorMessage:", wrongApiResult.errorMessage);

const runPaths: Record<string, string> = {};

async function run(label: string, baseUrl: string): Promise<ClassifierResult> {
	observed.length = 0;
	const result = await api.classify(makeModel(baseUrl), context, { apiKey: FAKE_KEY });
	runPaths[label] = observed[0]?.path ?? "<none>";
	console.log(`\n=== ${label} (baseUrl=${baseUrl}) ===`);
	console.log("observed requests:", observed.length);
	for (const o of observed) {
		console.log("  method:", o.method);
		console.log("  path:  ", o.path);
		console.log("  authorization:", o.headers["authorization"]);
		console.log("  content-type: ", o.headers["content-type"]);
		console.log("  body:", JSON.stringify(o.body));
	}
	console.log("result.stopReason:", result.stopReason);
	console.log("result.answers:", JSON.stringify(result.answers));
	console.log("result.usage:", JSON.stringify(result.usage));
	return result;
}

const r1 = await run("no /v1", baseUrlNoV1);
const r2 = await run("/v1 suffix", baseUrlV1);

server.stop(true);

// ---- Assertions -------------------------------------------------------------
const checks: [string, boolean][] = [];
checks.push(["bool answer mapped", r1.answers.is_urgent?.type === "bool"]);
checks.push(["choice answer mapped", r1.answers.sentiment?.type === "choice"]);
checks.push(["score answer mapped", r1.answers.quality?.type === "score"]);
checks.push(["usage parsed", r1.usage?.input === 123 && r1.usage?.output === 7]);
checks.push(["no-apiKey -> error", noKey.stopReason === "error"]);
checks.push(["model.apiKey ignored -> error", modelKeyOnly.stopReason === "error"]);
checks.push(["wrong api id -> error", wrongApiResult.stopReason === "error"]);
checks.push(["baseUrl without /v1 -> /systemone", runPaths["no /v1"] === "/systemone"]);
checks.push(["baseUrl with /v1 -> /v1/systemone", runPaths["/v1 suffix"] === "/v1/systemone"]);
checks.push(["both runs stopReason=stop", r1.stopReason === "stop" && r2.stopReason === "stop"]);

let failed = false;
for (const [name, ok] of checks) {
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
	if (!ok) failed = true;
}

console.log("\nSUMMARY");
console.log("baseUrl without /v1 -> path", runPaths["no /v1"]);
console.log("baseUrl with /v1    -> path", runPaths["/v1 suffix"]);
process.exit(failed ? 1 : 0);
