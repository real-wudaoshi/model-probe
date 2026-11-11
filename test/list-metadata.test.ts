// Inline metadata carried by /models list entries. The gateway payloads are
// trimmed samples of real responses (test/fixtures/lists); every expected
// value below was read off the raw payload by hand.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { closeAllServers, fixture, isolateEnvironment, list, serveList } from "./helpers.ts";

isolateEnvironment();
const { probeModels } = await import("../index.ts");
type Info = import("../index.ts").ModelProbeInfo;

after(closeAllServers);

async function infoFor(payload: unknown): Promise<Map<string, Info>> {
	const server = await serveList(payload);
	try {
		return (await probeModels(`${server.url}/v1`)).infoById;
	} finally {
		await server.close();
	}
}

/** Parse a single list entry. */
async function parse(entry: Record<string, unknown>): Promise<Info | undefined> {
	return (await infoFor(list([{ id: "m", ...entry }]))).get("m");
}

describe("real gateway payloads", () => {
	it("OpenRouter", async () => {
		const info = await infoFor(fixture("openrouter"));
		assert.deepEqual(info.get("anthropic/claude-fable-5.2"), {
			contextWindow: 1000000,
			maxTokens: 128000, // top_provider.max_completion_tokens
			reasoning: true, // supported_parameters lists "reasoning"
			image: true,
			video: false,
			cost: { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 }, // published per token
		});
		// supported_parameters is exhaustive: no reasoning entry means no reasoning.
		assert.equal(info.get("openai/gpt-4.1")?.reasoning, false);
		assert.deepEqual(info.get("openai/gpt-4.1")?.cost, { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 });
		assert.equal(info.get("google/gemini-4-carbon")?.video, true);
		// A free model is priced at zero — that is information, not a missing price.
		assert.deepEqual(info.get("baidu/ernie-5.5-flash-preview:free")?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		// The router entry publishes "-1" as a placeholder price: no cost at all.
		const auto = info.get("openrouter/auto");
		assert.equal(auto?.contextWindow, 2000000);
		assert.equal(auto?.cost, undefined);
		assert.equal(auto?.maxTokens, undefined, "top_provider.max_completion_tokens is null");
	});

	it("Vercel AI Gateway", async () => {
		const info = await infoFor(fixture("vercel"));
		assert.deepEqual(info.get("anthropic/claude-sonnet-4.5"), {
			contextWindow: 1000000,
			maxTokens: 64000,
			reasoning: true,
			image: true, // modalities.input is an object property here, not a top-level array
			video: false,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		});
		assert.equal(info.get("alibaba/qwen-3-235b")?.reasoning, false);
		assert.equal(info.get("alibaba/qwen3.6-35b-a3b")?.video, true);
		// An embedding model repeats its context window as max_tokens: not an output cap.
		const embedding = info.get("alibaba/qwen3-embedding-0.6b");
		assert.equal(embedding?.contextWindow, 32768);
		assert.equal(embedding?.maxTokens, undefined);
		assert.equal(embedding?.reasoning, undefined, "nothing in the entry speaks about reasoning");
	});

	it("Cerebras", async () => {
		const info = await infoFor(fixture("cerebras"));
		assert.deepEqual(info.get("gpt-oss-120b"), {
			contextWindow: 131072, // limits.max_context_length
			maxTokens: 40960, // limits.max_completion_tokens
			reasoning: true, // capabilities is an object of booleans
			image: false,
			cost: { input: 0.35, output: 0.75, cacheRead: 0, cacheWrite: 0 },
		});
		assert.equal(info.get("qwen-3.8-27b")?.image, true);
	});

	it("Chutes (prices already per 1M tokens)", async () => {
		const info = await infoFor(fixture("chutes"));
		assert.deepEqual(info.get("Qwen/Qwen3.8-27B-TEE"), {
			contextWindow: 262144,
			maxTokens: 65536, // max_output_length
			reasoning: true, // supported_features
			image: true,
			video: false,
			cost: { input: 0.039, output: 1.25, cacheRead: 0.0039, cacheWrite: 0 },
		});
		assert.equal(info.get("deepseek-ai/DeepSeek-V4.1-Flash-1017"), undefined, "a bare entry carries nothing");
	});

	it("DeepInfra (everything under metadata)", async () => {
		const info = await infoFor(fixture("deepinfra"));
		assert.deepEqual(info.get("anthropic/claude-fable-5"), {
			contextWindow: 1000000,
			// metadata.max_tokens repeats the context window: not an output cap.
			reasoning: true,
			image: true, // tags: vlm / vision
			cost: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
		});
		assert.equal(info.get("Pixverse/Pixverse-T2V"), undefined);
	});

	it("Venice (model_spec)", async () => {
		const info = await infoFor(fixture("venice"));
		assert.deepEqual(info.get("gemini-4-argon"), {
			contextWindow: 1000000,
			maxTokens: 65536,
			reasoning: true,
			image: true,
			video: true,
			cost: { input: 2.5, output: 12.5, cacheRead: 0.125, cacheWrite: 0 },
		});
		const plain = info.get("qwen3-235b-a22b-instruct-2507");
		assert.equal(plain?.reasoning, false);
		assert.equal(plain?.image, false);
	});

	it("Novita", async () => {
		const info = await infoFor(fixture("novita"));
		assert.deepEqual(info.get("tencent/hy4"), {
			contextWindow: 1000000, // context_size
			maxTokens: 64000,
			reasoning: true, // features
			image: true,
			video: false,
			cost: { input: 0.417, output: 1.2505, cacheRead: 0.021, cacheWrite: 0 }, // price_per_m_decimal
		});
		assert.equal(info.get("ming-image-0.1-design-layer")?.contextWindow, undefined, "context_size 0 is not a window");
	});

	it("OpenCode Zen (models.dev-shaped entries)", async () => {
		const info = await infoFor(fixture("opencode-zen"));
		assert.deepEqual(info.get("big-pickle"), {
			contextWindow: 200000,
			maxTokens: 32000,
			reasoning: true, // capabilities.reasoning.supported
			image: false,
			video: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("Hugging Face router (modalities only)", async () => {
		const info = await infoFor(fixture("huggingface"));
		assert.deepEqual(info.get("Qwen/Qwen3.8-27B"), { image: true, video: false });
		assert.deepEqual(info.get("meta-llama/Llama-3.1-8B-Instruct"), { image: false, video: false });
	});
});

describe("limits", () => {
	it("reads the common spellings of the context window and the output cap", async () => {
		assert.deepEqual(await parse({ context_window: 131072, max_completion_tokens: 8192 }), { contextWindow: 131072, maxTokens: 8192 }, "Groq");
		assert.deepEqual(await parse({ max_context_length: 128000 }), { contextWindow: 128000 }, "Mistral");
		assert.deepEqual(await parse({ max_model_len: 32768 }), { contextWindow: 32768 }, "vLLM");
		assert.deepEqual(await parse({ inputTokenLimit: 1048576, outputTokenLimit: 65536 }), { contextWindow: 1048576, maxTokens: 65536 }, "Gemini");
		assert.deepEqual(await parse({ max_input_tokens: 200000, max_tokens: 64000 }), { contextWindow: 200000, maxTokens: 64000 }, "Anthropic");
	});

	it("accepts numbers serialized as strings", async () => {
		assert.deepEqual(await parse({ context_length: "128000", max_output_tokens: "4096" }), { contextWindow: 128000, maxTokens: 4096 });
	});

	it("ignores zero, negative and non-numeric limits", async () => {
		assert.equal(await parse({ context_length: 0, max_output_tokens: -1 }), undefined);
		assert.equal(await parse({ context_length: "unlimited" }), undefined);
		assert.equal(await parse({ context_length: null }), undefined);
	});

	it("does not take a bare max_tokens for an output cap unless it is smaller than the window", async () => {
		assert.deepEqual(await parse({ context_length: 8192, max_tokens: 8192 }), { contextWindow: 8192 });
		assert.equal(await parse({ max_tokens: 4096 }), undefined, "no window to compare with");
		assert.deepEqual(await parse({ context_length: 8192, max_tokens: 2048 }), { contextWindow: 8192, maxTokens: 2048 });
	});
});

describe("capabilities", () => {
	it("reads capability arrays", async () => {
		assert.deepEqual(await parse({ capabilities: ["completion", "vision", "thinking"] }), { reasoning: true, image: true });
		assert.deepEqual(await parse({ capabilities: ["completion", "tools"] }), { reasoning: false, image: false });
	});

	it("reads { supported } capability objects (Anthropic-style)", async () => {
		assert.deepEqual(await parse({ capabilities: { image_input: { supported: true }, thinking: { supported: false } } }), { reasoning: false, image: true });
	});

	it("reads top-level booleans", async () => {
		assert.deepEqual(await parse({ reasoning: false, supports_vision: true }), { reasoning: false, image: true });
		assert.deepEqual(await parse({ supports_image_in: true, supports_video_in: true, supports_reasoning: true }), { reasoning: true, image: true, video: true });
	});

	it("treats tags as proof of presence only", async () => {
		assert.deepEqual(await parse({ context_length: 1000, tags: ["vision", "reasoning"] }), { contextWindow: 1000, reasoning: true, image: true });
		assert.deepEqual(await parse({ context_length: 1000, tags: ["tool-use"] }), { contextWindow: 1000 }, "a missing tag proves nothing");
	});

	it("only lets a recognizable parameter list prove the absence of reasoning", async () => {
		assert.equal((await parse({ context_length: 1000, supported_parameters: ["temperature", "tools"] }))?.reasoning, false);
		// An unrelated array that happens to use the same key says nothing.
		assert.equal((await parse({ context_length: 1000, features: ["fast", "eu-hosted"] }))?.reasoning, undefined);
		assert.equal((await parse({ context_length: 1000, supported_parameters: [] }))?.reasoning, undefined);
	});

	it("reads One API / New API meta and endpoint types", async () => {
		assert.deepEqual(
			await parse({
				supported_endpoint_types: ["chat", "embeddings"],
				meta: { context_window: 64000, max_output_tokens: 4096, capabilities: { vision: true, thinking: true } },
			}),
			{ endpointTypes: ["chat", "embeddings"], contextWindow: 64000, maxTokens: 4096, image: true, reasoning: true },
		);
		assert.deepEqual(await parse({ meta: { max_input_tokens: 32000, supports_vision: false, supports_reasoning: false } }), {
			contextWindow: 32000,
			image: false,
			reasoning: false,
		});
	});
});

describe("prices (always USD per 1M tokens)", () => {
	const cost = async (entry: Record<string, unknown>) => (await parse({ context_length: 1000, ...entry }))?.cost;

	it("converts per-token prices", async () => {
		assert.deepEqual(await cost({ pricing: { prompt: "0.000003", completion: "0.000015" } }), { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 });
		// The most expensive real prices (hundreds of dollars per 1M) are still per token.
		assert.deepEqual(await cost({ pricing: { prompt: "0.00015", completion: "0.0006" } }), { input: 150, output: 600, cacheRead: 0, cacheWrite: 0 });
		// 4.4e-7 * 1e6 must not surface as 0.44000000000000006.
		assert.equal((await cost({ pricing: { prompt: 4.4e-7, completion: 8.7e-7 } }))?.input, 0.44);
	});

	it("keeps prices that are already per 1M tokens", async () => {
		assert.deepEqual(await cost({ pricing: { input: 0.88, output: 0.88 } }), { input: 0.88, output: 0.88, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(await cost({ pricing: { prompt: 0.039, completion: 1.25 } }), { input: 0.039, output: 1.25, cacheRead: 0, cacheWrite: 0 });
	});

	it("drops placeholder and unusable prices", async () => {
		assert.equal(await cost({ pricing: { prompt: "-1", completion: "-1" } }), undefined);
		assert.equal(await cost({ pricing: { prompt: "", completion: null } }), undefined);
		assert.equal(await cost({ pricing: { prompt: "free" } }), undefined);
		assert.equal(await cost({ pricing: {} }), undefined);
		// One usable side is enough; the unusable one counts as zero.
		assert.deepEqual(await cost({ pricing: { prompt: "0.000001", completion: "-1" } }), { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("reads a models.dev-shaped cost object", async () => {
		assert.deepEqual(await cost({ cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } }), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		assert.deepEqual(await cost({ cost: { text: { input: { price: 1, cache: { read: 0.1, write: 1.25 } }, output: { price: 5 } } } }), {
			input: 1,
			output: 5,
			cacheRead: 0.1,
			cacheWrite: 1.25,
		});
	});
});
