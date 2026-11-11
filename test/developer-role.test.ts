// probeDeveloperRole: does the gateway accept the OpenAI "developer" role?
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { closeAllServers, html, isolateEnvironment, json, list, notFound, serve } from "./helpers.ts";

isolateEnvironment();
const { chatModelCandidates, detectModels, probeDeveloperRole } = await import("../index.ts");

after(closeAllServers);

const COMPLETION = { id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] };

/** A gateway whose /v1/chat/completions always gives the same answer. */
function answering(status: number, body: unknown) {
	return serve((req, res) => (req.url === "/v1/chat/completions" ? json(res, body, status) : notFound(res)));
}

async function verdict(status: number, body: unknown): Promise<boolean | undefined> {
	const server = await answering(status, body);
	try {
		return await probeDeveloperRole(`${server.url}/v1`, "sk-test", "some-model");
	} finally {
		await server.close();
	}
}

describe("probeDeveloperRole — a clear answer", () => {
	it("is true when the completion goes through", async () => {
		const server = await answering(200, COMPLETION);
		assert.equal(await probeDeveloperRole(`${server.url}/v1`, "sk-test", "gpt-4o"), true);
		const request = JSON.parse(server.hits[0].body);
		assert.equal(request.model, "gpt-4o");
		assert.equal(request.messages[0].role, "developer");
		assert.equal(request.stream, false);
		assert.equal(server.hits[0].headers.authorization, "Bearer sk-test");
	});

	it("is false when the gateway rejects the role", async () => {
		for (const message of [
			"role 'developer' is not allowed",
			"Invalid value: 'developer'. Supported values are: 'system', 'assistant', 'user', 'function', and 'tool'. (param: messages[0].role)",
			"messages[0].role: unknown variant `developer`, expected one of `system`, `user`, `assistant`, `tool`",
			"Unsupported role: developer",
			"invalid role",
			"Only user and assistant roles are supported",
		]) {
			assert.equal(await verdict(400, { error: { message, type: "invalid_request_error" } }), false, message);
		}
	});

	it("reads a rejection delivered with status 200 or 422 or 500", async () => {
		assert.equal(await verdict(200, { error: { message: "role 'developer' is not allowed" } }), false);
		assert.equal(await verdict(200, { success: false, message: "不支持的角色 role: developer" }), false);
		assert.equal(await verdict(422, { detail: [{ loc: ["body", "messages", 0, "role"], msg: "Input should be 'system', 'user' or 'assistant'" }] }), false);
		assert.equal(await verdict(500, { error: { message: "jinja template error: unexpected role developer" } }), false);
	});
});

describe("probeDeveloperRole — no conclusion", () => {
	it("is undefined for failures that say nothing about the role", async () => {
		assert.equal(await verdict(401, { error: { message: "Incorrect API key provided" } }), undefined);
		assert.equal(await verdict(402, { error: { message: "Insufficient balance" } }), undefined);
		assert.equal(await verdict(404, { error: { message: "The model `some-model` does not exist" } }), undefined);
		assert.equal(await verdict(500, { error: { message: "upstream error" } }), undefined);
		assert.equal(await verdict(200, { error: { message: "model overloaded" } }), undefined);
	});

	it("is not fooled by an unrelated error that merely contains the word 'developer'", async () => {
		assert.equal(
			await verdict(403, {
				error: {
					code: 403,
					message: "Generative Language API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/overview?project=123 then retry.",
					status: "PERMISSION_DENIED",
				},
			}),
			undefined,
		);
		assert.equal(await verdict(429, { error: { message: "Rate limit reached. See https://platform.example.com/docs/developer-guide/rate-limits" } }), undefined);
		assert.equal(await verdict(400, { error: { message: "Your developer account is not verified." } }), undefined);
	});

	it("does not take a 200 that is not a completion for a yes", async () => {
		assert.equal(await verdict(200, { status: "ok" }), undefined);
		assert.equal(await verdict(200, []), undefined);
		const console_ = await serve((_req, res) => html(res));
		assert.equal(await probeDeveloperRole(`${console_.url}/v1`, undefined, "m"), undefined, "a web page at the wrong base URL");
	});

	it("is undefined when the gateway cannot be reached or never answers", async () => {
		const silent = await serve(() => {});
		const started = Date.now();
		assert.equal(await probeDeveloperRole(`${silent.url}/v1`, undefined, "m"), undefined);
		assert.ok(Date.now() - started < 3000);
		const dead = silent.url;
		await silent.close();
		assert.equal(await probeDeveloperRole(`${dead}/v1`, undefined, "m"), undefined);
	});
});

describe("probeDeveloperRole — picking a model that can answer", () => {
	// Like OpenAI: completion-only models 404 on chat, reasoning models refuse max_tokens.
	function openaiLike(ids: string[]) {
		return serve((req, res, { body }) => {
			if (req.url === "/v1/models") return json(res, list(ids));
			if (req.url !== "/v1/chat/completions") return notFound(res);
			const request = JSON.parse(body);
			if (/babbage|embedding|whisper|tts|dall-e/.test(request.model)) {
				return json(res, { error: { message: "This is not a chat model and thus not supported in the v1/chat/completions endpoint.", type: "invalid_request_error" } }, 404);
			}
			if (/^(o\d|gpt-5)/.test(request.model) && "max_tokens" in request) {
				return json(res, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: "max_tokens", code: "unsupported_parameter" } }, 400);
			}
			json(res, COMPLETION);
		});
	}
	const noExtras = { modelsDev: false, modelInfo: false, modelGroupInfo: false, publicCatalog: false, perModelDetails: false };
	const chatRequests = (server: Awaited<ReturnType<typeof openaiLike>>) => server.hits.filter((hit) => hit.method === "POST").map((hit) => JSON.parse(hit.body));

	it("does not waste the probe on a model that is not a chat model", async () => {
		const server = await openaiLike(["babbage-002", "dall-e-3", "gpt-4o", "text-embedding-3-small", "whisper-1"]);
		const result = await detectModels(`${server.url}/v1`, { profile: noExtras, developerRole: true });
		assert.equal(result.supportsDeveloperRole, true);
		assert.equal(result.developerRoleSource, "detected");
		assert.deepEqual(
			chatRequests(server).map((request) => request.model),
			["gpt-4o"],
		);
	});

	it("moves on to the next candidate when a model cannot answer", async () => {
		const server = await openaiLike(["aaa-not-obviously-embedding-babbage", "gpt-4o"]);
		assert.equal(await probeDeveloperRole(`${server.url}/v1`, undefined, ["babbage-002", "gpt-4o"]), true);
		assert.deepEqual(
			chatRequests(server).map((request) => request.model),
			["babbage-002", "gpt-4o"],
		);
	});

	it("retries with max_completion_tokens for models that refuse max_tokens", async () => {
		const server = await openaiLike(["gpt-5", "gpt-5-mini", "o3"]);
		const result = await detectModels(`${server.url}/v1`, { profile: noExtras, developerRole: true });
		assert.equal(result.supportsDeveloperRole, true);
		const requests = chatRequests(server);
		assert.equal(requests.length, 2);
		assert.ok("max_tokens" in requests[0] && !("max_completion_tokens" in requests[0]));
		assert.ok("max_completion_tokens" in requests[1] && !("max_tokens" in requests[1]));
	});

	it("asks at most three models", async () => {
		const server = await serve((req, res) => (req.url === "/v1/chat/completions" ? json(res, { error: { message: "model not found" } }, 404) : notFound(res)));
		assert.equal(await probeDeveloperRole(`${server.url}/v1`, undefined, ["a", "b", "c", "d", "e"]), undefined);
		assert.equal(server.hits.length, 3);
	});

	it("stops at the first model when the key itself is refused", async () => {
		const server = await answering(401, { error: { message: "Invalid API key" } });
		assert.equal(await probeDeveloperRole(`${server.url}/v1`, "sk-bad", ["a", "b", "c"]), undefined);
		assert.equal(server.hits.length, 1);
	});

	it("defaults to false, marked as a default, when the probe is inconclusive", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/v1/models") return json(res, list(["gpt-4o"]));
			if (req.url === "/v1/chat/completions") return json(res, { error: { message: "Insufficient balance" } }, 402);
			notFound(res);
		});
		const result = await detectModels(`${server.url}/v1`, { profile: noExtras, developerRole: true });
		assert.equal(result.supportsDeveloperRole, false);
		assert.equal(result.developerRoleSource, "default");
	});

	it("is not probed unless asked for", async () => {
		const server = await openaiLike(["gpt-4o"]);
		const result = await detectModels(`${server.url}/v1`, { profile: noExtras });
		assert.equal(result.supportsDeveloperRole, undefined);
		assert.equal(result.developerRoleSource, undefined);
		assert.deepEqual(chatRequests(server), []);
	});
});

describe("chatModelCandidates", () => {
	it("puts likely chat models first and keeps everything else as a last resort", () => {
		assert.deepEqual(chatModelCandidates(["babbage-002", "dall-e-3", "gpt-4o", "text-embedding-3-small", "whisper-1", "zeta-chat"]), [
			"gpt-4o",
			"zeta-chat",
			"babbage-002",
			"dall-e-3",
			"text-embedding-3-small",
			"whisper-1",
		]);
		assert.deepEqual(chatModelCandidates(["text-embedding-3-small"]), ["text-embedding-3-small"]);
		assert.deepEqual(chatModelCandidates([]), []);
	});
});
