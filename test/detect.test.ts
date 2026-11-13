// The resolve chain (detected > id hint > models.dev > rules > api fallback >
// defaults) and detectModels' orchestration of the metadata endpoints.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { closeAllServers, isolateEnvironment, json, list, notFound, serve, stubNetwork } from "./helpers.ts";

isolateEnvironment();
const { API_FALLBACK_LIMITS, detectModels, fetchGatewayWideInfo, fetchPerModelInfo, finalizeModelInfo, resolveModelInfo } = await import("../index.ts");
type Info = import("../index.ts").ModelProbeInfo;

// No test in this file may reach models.dev: anything external is refused.
const network = stubNetwork();
after(async () => {
	network.restore();
	await closeAllServers();
});

// Probe a mock gateway without the models.dev tier.
const NO_CATALOG = { modelsDev: false } as const;

describe("resolveModelInfo", () => {
	it("fills an unknown model with tagged defaults only", () => {
		assert.deepEqual(resolveModelInfo("totally-unknown-model-xyz"), {
			image: false,
			video: false,
			reasoning: true,
			defaultedFields: ["image", "video", "reasoning"],
		});
	});

	it("lets detected values win over every other tier", () => {
		const detected: Info = { contextWindow: 64000, maxTokens: 2000, image: false, video: false, reasoning: false };
		const catalog = new Map<string, Info>([["gpt-4o", { contextWindow: 128000, maxTokens: 16384, image: true, reasoning: true }]]);
		assert.deepEqual(resolveModelInfo("gpt-4o", detected, catalog, "openai-completions"), detected);
	});

	it("ranks models.dev above the local rules, and tags each field's source", () => {
		const catalog = new Map<string, Info>([["gpt-4o", { contextWindow: 111111, cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 } }]]);
		assert.deepEqual(resolveModelInfo("gpt-4o", undefined, catalog), {
			contextWindow: 111111, // catalog, not the rule's 128000
			cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
			modelsDevFields: ["contextWindow", "cost"],
			image: true, // rule
			inferred: true,
			inferredFields: ["image"],
			video: false,
			reasoning: true,
			defaultedFields: ["video", "reasoning"],
		});
	});

	it("does not mutate its inputs", () => {
		const detected: Info = { contextWindow: 64000 };
		const entry: Info = { maxTokens: 4096, image: true };
		const catalog = new Map([["some-model", entry]]);
		resolveModelInfo("some-model", detected, catalog, "openai-completions");
		assert.deepEqual(detected, { contextWindow: 64000 });
		assert.deepEqual(entry, { maxTokens: 4096, image: true });
	});

	it("uses ID hints when neither the gateway nor an exact catalog entry supplies context", () => {
		const catalog = new Map<string, Info>([["claude-opus-4-5[1m]", { contextWindow: 200000, maxTokens: 64000 }]]);
		assert.equal(resolveModelInfo("claude-opus-4-5[1m]", undefined, catalog).contextWindow, 200000);
		const info = resolveModelInfo("claude-opus-4-5[1m]");
		assert.equal(info.contextWindow, 1000000);
		assert.ok(info.inferredFields?.includes("contextWindow"), "tagged as inferred, not as detected");
		assert.equal(resolveModelInfo("some-model[200k]").contextWindow, 200000);
		// ...but not ahead of what the gateway itself reported.
		assert.equal(resolveModelInfo("claude-opus-4-5[1m]", { contextWindow: 500000 }).contextWindow, 500000);
		// A bracket that is not a size is not a hint.
		assert.equal(resolveModelInfo("some-model[beta]").contextWindow, undefined);
	});
});

describe("api fallback limits", () => {
	it("supplies both limits when nothing else knows them", () => {
		const info = resolveModelInfo("totally-unknown-model-xyz", undefined, undefined, "anthropic-messages");
		assert.equal(info.contextWindow, 200000);
		assert.equal(info.maxTokens, 32000);
		assert.deepEqual(info.defaultedFields, ["contextWindow", "maxTokens", "image", "video", "reasoning"]);
	});

	it("never hands out an output cap larger than a known context window", () => {
		// The rule knows deepseek-coder's 16K window; a 32K output default would not fit in it.
		const coder = resolveModelInfo("deepseek-coder", undefined, undefined, "openai-completions");
		assert.equal(coder.contextWindow, 16384);
		assert.equal(coder.maxTokens, 4096);
		// A detected window (a local model with num_ctx 4096).
		const local = resolveModelInfo("my-local-model", { contextWindow: 4096 }, undefined, "google-generative-ai");
		assert.equal(local.maxTokens, 1024);
		assert.ok(local.defaultedFields?.includes("maxTokens"));
		// A roomy window keeps the full default.
		assert.equal(resolveModelInfo("big-model", { contextWindow: 1000000 }, undefined, "openai-completions").maxTokens, 32000);
	});

	it("is off for an unknown flavor, including names that exist on every object", () => {
		for (const api of ["openai", "constructor", "toString", "__proto__", ""]) {
			const info = resolveModelInfo("totally-unknown-model-xyz", undefined, undefined, api);
			assert.equal(info.contextWindow, undefined, api);
			assert.equal(info.maxTokens, undefined, api);
		}
	});

	it("adds no empty tag list when it had nothing to fill", () => {
		const full: Info = { contextWindow: 1000, maxTokens: 100, image: true, video: false, reasoning: false };
		assert.deepEqual(resolveModelInfo("x", full, undefined, "openai-completions"), full);
	});

	it("keeps the documented flavors", () => {
		assert.deepEqual(Object.keys(API_FALLBACK_LIMITS).sort(), ["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"]);
	});
});

describe("limits borrowed from different sources stay coherent", () => {
	it("shrinks a catalog output cap that does not fit the window the gateway reported", () => {
		// The relay serves this model with a 32K window; the catalog describes the maker's 128K output.
		const catalog = new Map<string, Info>([["big-out", { contextWindow: 1000000, maxTokens: 128000 }]]);
		const info = resolveModelInfo("big-out", { contextWindow: 32000 }, catalog);
		assert.equal(info.contextWindow, 32000);
		assert.equal(info.maxTokens, 8000);
		assert.ok(!info.modelsDevFields?.includes("maxTokens"), "no longer presented as catalog data");
		assert.ok(info.defaultedFields?.includes("maxTokens"));
	});

	it("leaves limits the gateway itself reported exactly as reported", () => {
		const info = resolveModelInfo("odd-model", { contextWindow: 8192, maxTokens: 8192 });
		assert.equal(info.maxTokens, 8192);
		assert.ok(!info.defaultedFields?.includes("maxTokens"));
	});

	it("leaves a borrowed cap that fits alone", () => {
		const catalog = new Map<string, Info>([["m", { maxTokens: 16384 }]]);
		const info = resolveModelInfo("m", { contextWindow: 128000 }, catalog);
		assert.equal(info.maxTokens, 16384);
		assert.deepEqual(info.modelsDevFields, ["maxTokens"]);
	});
});

describe("finalizeModelInfo", () => {
	it("merges maps (later wins) and resolves every requested id", () => {
		const first = new Map<string, Info>([["m", { contextWindow: 1000, image: true }]]);
		const second = new Map<string, Info>([["m", { contextWindow: 2000 }]]);
		const result = finalizeModelInfo(["m", "n"], [first, second]);
		assert.equal(result.get("m")?.contextWindow, 2000);
		assert.equal(result.get("m")?.image, true);
		assert.deepEqual(result.get("n"), { image: false, video: false, reasoning: true, defaultedFields: ["image", "video", "reasoning"] });
	});
});

describe("detectModels — which requests it makes", () => {
	it("stops asking /models/{id} once it is clear they add nothing", async () => {
		const entry = (i: number) => ({ id: `vendor/model-${i}`, context_length: 128000, architecture: { input_modalities: ["text"] } });
		const data = Array.from({ length: 40 }, (_, i) => entry(i));
		const server = await serve((req, res) => {
			if (req.url === "/v1/models") return json(res, { data });
			// Like OpenRouter: the detail object repeats the list entry.
			const match = /^\/v1\/models\/vendor%2Fmodel-(\d+)$/.exec(req.url ?? "");
			if (match) return json(res, entry(Number(match[1])));
			notFound(res);
		});
		const result = await detectModels(`${server.url}/v1`, { profile: NO_CATALOG });
		assert.equal(result.ids.length, 40);
		const detailRequests = server.paths().filter((path) => path.startsWith("/v1/models/"));
		assert.ok(detailRequests.length <= 8, `${detailRequests.length} per-model requests`);
		assert.equal(result.models.get("vendor/model-39")?.contextWindow, 128000);
	});

	it("keeps asking while the details do teach something new", async () => {
		const ids = Array.from({ length: 20 }, (_, i) => `model-${String(i).padStart(2, "0")}`);
		const server = await serve((req, res) => {
			if (req.url === "/v1/models") return json(res, list(ids));
			const id = (req.url ?? "").replace("/v1/models/", "");
			if (ids.includes(id)) return json(res, { id, context_window: 200000 });
			notFound(res);
		});
		const result = await detectModels(`${server.url}/v1`, { profile: NO_CATALOG });
		assert.equal(server.paths().filter((path) => path.startsWith("/v1/models/")).length, 20);
		assert.ok(ids.every((id) => result.models.get(id)?.contextWindow === 200000));
	});

	it("gives up quickly when /models/{id} never answers", async () => {
		const ids = Array.from({ length: 12 }, (_, i) => `m-${i}`);
		const server = await serve((req, res) => {
			if (req.url === "/v1/models") return json(res, list(ids));
			if (req.url?.startsWith("/v1/models/")) return; // silence
			notFound(res);
		});
		const started = Date.now();
		const result = await detectModels(`${server.url}/v1`, { profile: NO_CATALOG });
		assert.equal(result.ids.length, 12);
		assert.ok(Date.now() - started < 1500, `took ${Date.now() - started}ms — one timeout, not one per model`);
		assert.equal(server.paths().filter((path) => path.startsWith("/v1/models/")).length, 4, "a single wave");
	});

	it("asks per-model details only for the models the gateway-wide sources did not describe", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/v1/models" || req.url === "/models") return json(res, list(["a", "b", "c"]));
			if (req.url === "/model/info") return json(res, { data: [{ model_name: "a", model_info: { max_input_tokens: 128000 } }] });
			if (req.url === "/models/b" || req.url === "/models/c") return json(res, { id: req.url.slice(8), context_window: 200000 });
			notFound(res);
		});
		const result = await detectModels(server.url, { profile: NO_CATALOG });
		assert.deepEqual(server.paths().filter((path) => /^\/models\/./.test(path)).sort(), ["/models/b", "/models/c"]);
		assert.equal(result.models.get("a")?.contextWindow, 128000);
		assert.equal(result.models.get("b")?.contextWindow, 200000);
	});

	it("can be told to skip individual sources", async () => {
		const server = await serve((req, res) => (req.url === "/v1/models" ? json(res, list(["a"])) : notFound(res)));
		await detectModels(`${server.url}/v1`, {
			profile: { modelsDev: false, modelInfo: false, modelGroupInfo: false, publicCatalog: false, perModelDetails: false },
		});
		assert.deepEqual(server.paths(), ["/v1/models"]);
	});

	it("never sends the API key to the site's public catalog", async () => {
		const server = await serve((req, res) => (req.url === "/v1/models" ? json(res, list(["a"])) : notFound(res)));
		await detectModels(`${server.url}/v1`, { apiKey: "sk-secret", profile: NO_CATALOG });
		const catalogRequests = server.hits.filter((hit) => hit.url === "/api/models/public");
		assert.equal(catalogRequests.length, 1);
		assert.equal(catalogRequests[0].headers.authorization, undefined);
	});
});

describe("detectModels — results", () => {
	it("speaks only for the ids the key can list", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/v1/models" || req.url === "/models") return json(res, list(["gpt-4o"]));
			if (req.url === "/model/info") {
				return json(res, {
					data: [
						{ model_name: "gpt-4o", model_info: { max_input_tokens: 128000 } },
						{ model_name: "secret-internal-model", model_info: { max_input_tokens: 64000 } },
					],
				});
			}
			notFound(res);
		});
		const result = await detectModels(server.url, { profile: NO_CATALOG });
		assert.deepEqual([...result.models.keys()], ["gpt-4o"]);
	});

	it("keeps what the first LiteLLM deployment reported when a second one is sparse", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/v1/models" || req.url === "/models") return json(res, list(["gpt-4o"]));
			if (req.url === "/model/info") {
				return json(res, {
					data: [
						{
							model_name: "gpt-4o",
							model_info: { max_input_tokens: 128000, max_output_tokens: 16384, supports_vision: true, input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001 },
						},
						{ model_name: "gpt-4o", model_info: { max_input_tokens: null, max_output_tokens: null, supports_vision: null, input_cost_per_token: 0.000003, output_cost_per_token: 0 } },
					],
				});
			}
			notFound(res);
		});
		const info = (await detectModels(server.url, { profile: NO_CATALOG })).models.get("gpt-4o");
		assert.equal(info?.contextWindow, 128000);
		assert.equal(info?.maxTokens, 16384);
		assert.equal(info?.image, true);
		assert.deepEqual(info?.cost, { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 });
		assert.equal(info?.inferred, undefined, "nothing had to be guessed");
	});

	it("with knownModelFallback off, reports only what the gateway said and fetches no catalog", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/v1/models") return json(res, list(["gpt-4o", { id: "described", context_length: 4096 }]));
			notFound(res);
		});
		network.requested.length = 0;
		const result = await detectModels(`${server.url}/v1`, { knownModelFallback: false });
		assert.deepEqual(network.requested, [], "models.dev is not downloaded just to be thrown away");
		assert.deepEqual(result.ids, ["described", "gpt-4o"]);
		assert.deepEqual(result.models.get("described"), { contextWindow: 4096 });
		assert.equal(result.models.get("gpt-4o"), undefined);
	});

	it("uses Ollama's native endpoints, including the thinking capability and num_ctx", async () => {
		const server = await serve((req, res, { body }) => {
			if (req.url === "/v1/models") return json(res, list(["qwen3:8b", "llama3.2:latest", "custom:latest"]));
			if (req.url === "/api/tags") return json(res, { models: [{ name: "qwen3:8b" }, { name: "llama3.2:latest" }, { name: "custom:latest" }] });
			if (req.url === "/api/show") {
				const name = JSON.parse(body).model;
				if (name === "qwen3:8b") return json(res, { capabilities: ["completion", "tools", "thinking"], model_info: { "qwen3.context_length": 40960 } });
				if (name === "llama3.2:latest") return json(res, { capabilities: ["completion", "vision"], model_info: { "llama.context_length": 131072 } });
				return json(res, { capabilities: ["completion"], model_info: { "llama.context_length": 131072 }, parameters: 'num_ctx 8192\nstop "<|eot|>"' });
			}
			notFound(res);
		});
		const result = await detectModels(`${server.url}/v1`, { ollama: true, profile: NO_CATALOG });
		const qwen = result.models.get("qwen3:8b");
		assert.equal(qwen?.contextWindow, 40960);
		assert.equal(qwen?.reasoning, true);
		assert.equal(qwen?.image, false);
		const llama = result.models.get("llama3.2:latest");
		assert.equal(llama?.reasoning, false, "detected from capabilities, not defaulted to true");
		assert.ok(!llama?.defaultedFields?.includes("reasoning"));
		assert.equal(llama?.image, true);
		assert.equal(result.models.get("custom:latest")?.contextWindow, 8192, "the Modelfile's num_ctx is the window in effect");
		// Ollama mode has no gateway-wide or OpenAI per-model requests.
		assert.ok(server.paths().every((path) => ["/v1/models", "/api/tags", "/api/show"].includes(path)), server.paths().join(" "));
	});
});

describe("building blocks used by better-custom", () => {
	it("fetchGatewayWideInfo merges the three sources in priority order", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/model/info") return json(res, { data: [{ model_name: "m", model_info: { max_input_tokens: 1000, max_output_tokens: 100 } }] });
			if (req.url === "/api/models/public") return json(res, [{ model_name: "m", context_window: 2000 }, { model_name: "draft", context_window: 1, status: "draft" }]);
			if (req.url === "/model_group/info") {
				return req.headers.authorization === "Bearer sk"
					? json(res, { data: [{ model_group: "m", max_input_tokens: 3000, supports_vision: true }, { model_group: "only-group", max_input_tokens: 4000 }] })
					: json(res, { error: "auth" }, 401);
			}
			notFound(res);
		});
		const info = await fetchGatewayWideInfo(`${server.url}/v1`, { apiKey: "sk" });
		assert.deepEqual(info.get("m"), { contextWindow: 2000, maxTokens: 100, image: true }, "public catalog overrides /model/info; the group fills gaps");
		assert.deepEqual(info.get("only-group"), { contextWindow: 4000 });
		assert.equal(info.has("draft"), false);
		assert.equal((await fetchGatewayWideInfo(`${server.url}/v1`, { ollama: true })).size, 0);
	});

	it("fetchPerModelInfo works without the optional known map", async () => {
		const server = await serve((req, res) =>
			req.url === "/v1/models/m"
				? json(res, { id: "m", context_window: 200000, capabilities: { vision: { supported: true }, reasoning: { type: "effort", effort_options: ["low", "high"] } } })
				: notFound(res),
		);
		const info = await fetchPerModelInfo(`${server.url}/v1`, ["m"], { apiKey: "sk" });
		assert.deepEqual(info.get("m"), { contextWindow: 200000, image: true, reasoning: true, effortOptions: ["low", "high"] });
	});

	it("fetchPerModelInfo reads the always-thinking marker", async () => {
		const server = await serve((req, res) =>
			req.url === "/v1/models/m" ? json(res, { id: "m", capabilities: { reasoning: { type: "minimal" } } }) : json(res, { id: "n", capabilities: { reasoning: { type: "none" } } }),
		);
		const info = await fetchPerModelInfo(`${server.url}/v1`, ["m", "n"]);
		assert.deepEqual(info.get("m"), { reasoning: true, alwaysThinking: true });
		assert.deepEqual(info.get("n"), { reasoning: false });
	});
});
