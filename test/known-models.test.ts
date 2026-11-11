// Known-model rules and model-id normalization.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isolateEnvironment, tempDir } from "./helpers.ts";

isolateEnvironment();
const { applyKnownModelFallback, normalizeModelIdCandidates, registerKnownModelRules, reloadKnownModelRules } = await import("../index.ts");

describe("normalizeModelIdCandidates", () => {
	const candidates = (id: string) => normalizeModelIdCandidates(id);

	it("starts with the id as given, then lowercase", () => {
		assert.deepEqual(candidates("GPT-4o"), ["GPT-4o", "gpt-4o"]);
		assert.deepEqual(candidates("  gpt-4o  "), ["gpt-4o"]);
	});

	it("strips relay prefixes last, so an exact vendor/model entry wins", () => {
		assert.deepEqual(candidates("bailian/deepseek-v4-pro"), ["bailian/deepseek-v4-pro", "deepseek-v4-pro"]);
		assert.deepEqual(candidates("azure/openai/gpt-4o"), ["azure/openai/gpt-4o", "gpt-4o"]);
	});

	it("peels a prefix AND a suffix off the same id", () => {
		assert.ok(candidates("bailian/deepseek-chat-free").includes("deepseek-chat"));
		assert.ok(candidates("aws/claude-sonnet-4-5-thinking").includes("claude-sonnet-4-5"));
	});

	it("peels stacked suffixes one layer at a time", () => {
		assert.deepEqual(candidates("claude-sonnet-4-5-20250929-thinking"), [
			"claude-sonnet-4-5-20250929-thinking",
			"claude-sonnet-4-5-20250929",
			"claude-sonnet-4-5",
		]);
		assert.ok(candidates("gemini-2.5-flash-preview-05-20").includes("gemini-2.5-flash"));
	});

	it("understands dashed dates", () => {
		assert.ok(candidates("gpt-4.1-2025-04-14").includes("gpt-4.1"));
		assert.ok(candidates("o3-mini-2025-01-31").includes("o3-mini"));
	});

	it("understands :variant tags (OpenRouter, Ollama)", () => {
		assert.ok(candidates("deepseek/deepseek-r1:free").includes("deepseek-r1"));
		assert.ok(candidates("qwen3:8b").includes("qwen3"));
		assert.ok(candidates("llama3.2:latest").includes("llama3.2"));
	});

	it("understands effort suffixes and @version", () => {
		assert.ok(candidates("gpt-5-high").includes("gpt-5"));
		assert.ok(candidates("gpt-5-codex-xhigh").includes("gpt-5-codex"));
		assert.ok(candidates("gpt-5@20250807").includes("gpt-5"));
		assert.ok(candidates("claude-sonnet-4-6[1m]").includes("claude-sonnet-4-6"));
	});

	it("keeps ids that begin with @ (Cloudflare Workers AI)", () => {
		const result = candidates("@cf/meta/llama-3.1-8b-instruct");
		assert.equal(result[0], "@cf/meta/llama-3.1-8b-instruct");
		assert.ok(result.includes("llama-3.1-8b-instruct"));
	});

	it("reaches the base model of an OpenAI fine-tune", () => {
		assert.ok(candidates("ft:gpt-4o-mini-2024-07-18:my-org:custom:abc123").includes("gpt-4o-mini"));
	});

	it("never produces an empty or duplicate candidate", () => {
		for (const id of ["-", "/", "@", "a/", "/a", "[1m]", "x@", ":free", "-latest", "a//b"]) {
			const result = candidates(id);
			assert.ok(
				result.every((candidate) => candidate.length > 0),
				`${id} -> ${JSON.stringify(result)}`,
			);
			assert.equal(new Set(result).size, result.length, id);
		}
		assert.deepEqual(candidates(""), []);
	});

	it("does not strip what is part of the model name", () => {
		// "-4" / "-5" are version numbers, not serial tails.
		assert.deepEqual(candidates("gpt-4"), ["gpt-4"]);
		assert.deepEqual(candidates("claude-opus-4-5"), ["claude-opus-4-5"]);
		assert.deepEqual(candidates("o3-mini"), ["o3-mini"]);
	});
});

describe("applyKnownModelFallback", () => {
	it("fills only what is missing and tags it", () => {
		assert.deepEqual(applyKnownModelFallback("gpt-4o", undefined), {
			contextWindow: 128000,
			image: true,
			inferred: true,
			inferredFields: ["contextWindow", "image"],
		});
		// A detected value is never overwritten.
		assert.deepEqual(applyKnownModelFallback("gpt-4o", { contextWindow: 64000, image: false }), { contextWindow: 64000, image: false });
	});

	it("returns the input untouched for an unknown model", () => {
		assert.equal(applyKnownModelFallback("totally-unknown-model-xyz", undefined), undefined);
		const info = { contextWindow: 1 };
		assert.equal(applyKnownModelFallback("totally-unknown-model-xyz", info), info);
	});

	it("matches decorated ids through the normalization chain", () => {
		for (const id of ["bailian/gpt-4o", "gpt-4o-2024-08-06", "GPT-4O", "gpt-4o:free", "azure/openai/gpt-4o@v2"]) {
			assert.equal(applyKnownModelFallback(id, undefined)?.contextWindow, 128000, id);
		}
	});

	it("gives the same answer on every call", () => {
		const first = applyKnownModelFallback("claude-sonnet-4-5", undefined);
		for (let i = 0; i < 5; i++) assert.deepEqual(applyKnownModelFallback("claude-sonnet-4-5", undefined), first);
	});
});

describe("user rules", () => {
	const dir = tempDir();
	// Point the user-rules path at a file with the given bytes, run, then restore.
	function withRulesFile(name: string, bytes: Buffer | string, run: () => void): void {
		const previous = process.env.MODEL_PROBE_RULES;
		const path = join(dir, name);
		writeFileSync(path, bytes);
		process.env.MODEL_PROBE_RULES = path;
		reloadKnownModelRules();
		try {
			run();
		} finally {
			process.env.MODEL_PROBE_RULES = previous;
			reloadKnownModelRules();
		}
	}
	const rules = JSON.stringify([{ pattern: "^my-model", contextWindow: 65536 }]);
	const expectApplied = () => assert.equal(applyKnownModelFallback("my-model-1", undefined)?.contextWindow, 65536);

	it("are read from the file named by MODEL_PROBE_RULES", () => {
		withRulesFile("plain.json", rules, expectApplied);
	});

	it("survive a UTF-8 byte order mark", () => {
		withRulesFile("bom.json", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rules)]), expectApplied);
	});

	it("survive UTF-16 (what Windows PowerShell writes with >)", () => {
		withRulesFile("utf16le.json", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rules, "utf16le")]), expectApplied);
		const bigEndian = Buffer.from(rules, "utf16le");
		bigEndian.swap16();
		withRulesFile("utf16be.json", Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]), expectApplied);
	});

	it("accept numbers written as strings", () => {
		withRulesFile("strings.json", '[{ "pattern": "^my-model", "contextWindow": "65536" }]', expectApplied);
	});

	it("override the built-in table per field, and inherit the rest", () => {
		withRulesFile("override.json", '[{ "pattern": "^gpt-4o", "contextWindow": 50000 }]', () => {
			const info = applyKnownModelFallback("gpt-4o", undefined);
			assert.equal(info?.contextWindow, 50000);
			assert.equal(info?.image, true, "still inherited from the built-in rule");
		});
	});

	it("say why a broken file is ignored instead of failing silently", (t) => {
		const warnings: string[] = [];
		t.mock.method(console, "warn", (message: string) => warnings.push(message));
		withRulesFile("broken.json", '[{ "pattern": "^my-model", "contextWindow": 65536 },]', () => {
			assert.equal(applyKnownModelFallback("my-model-1", undefined), undefined);
			// The built-in rules still work.
			assert.equal(applyKnownModelFallback("gpt-4o", undefined)?.contextWindow, 128000);
		});
		withRulesFile("object.json", '{ "pattern": "^my-model" }', () => {
			assert.equal(applyKnownModelFallback("my-model-1", undefined), undefined);
		});
		assert.equal(warnings.length, 2, warnings.join("\n"));
		assert.match(warnings[0], /broken\.json/);
		assert.match(warnings[1], /expected a JSON array/);
	});
});

describe("registerKnownModelRules", () => {
	it("takes precedence over the built-in table", () => {
		registerKnownModelRules([{ pattern: "^registered-model", contextWindow: 77777, reasoning: false }]);
		assert.deepEqual(applyKnownModelFallback("registered-model-v2", undefined), {
			contextWindow: 77777,
			reasoning: false,
			inferred: true,
			inferredFields: ["contextWindow", "reasoning"],
		});
	});

	it("is not thrown off by the g / y regex flags", () => {
		registerKnownModelRules([
			{ pattern: "sticky-model", flags: "gi", contextWindow: 11111 },
			{ pattern: "other-sticky", flags: "y", contextWindow: 22222 },
		]);
		for (let i = 0; i < 4; i++) {
			assert.equal(applyKnownModelFallback("my-sticky-model", undefined)?.contextWindow, 11111, `call ${i + 1}`);
			assert.equal(applyKnownModelFallback("an-other-sticky", undefined)?.contextWindow, 22222, `call ${i + 1}`);
		}
	});

	it("skips an invalid pattern without breaking the others", (t) => {
		t.mock.method(console, "warn", () => {});
		registerKnownModelRules([{ pattern: "(unclosed", contextWindow: 1 }, { pattern: "^after-invalid", contextWindow: 33333 }]);
		assert.equal(applyKnownModelFallback("after-invalid", undefined)?.contextWindow, 33333);
	});
});
