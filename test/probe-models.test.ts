// probeModels: finding the model list, whatever the gateway does at /models.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { closeAllServers, html, isolateEnvironment, json, jsonResponse, list, notFound, serve, serveList, stubNetwork } from "./helpers.ts";

isolateEnvironment();
const { probeDeveloperRole, probeModels } = await import("../index.ts");
const { mayForwardCredentials, resetAuthSchemeCache } = await import("../src/http.ts");

after(closeAllServers);

describe("probeModels — where the list lives", () => {
	it("returns sorted, de-duplicated ids and the base that answered", async () => {
		const server = await serveList(list(["zeta", "alpha", "alpha", { id: "  beta  " }, { id: "" }, { object: "model" }]));
		const result = await probeModels(`${server.url}/v1`);
		assert.deepEqual(result.ids, ["alpha", "beta", "zeta"]);
		assert.equal(result.baseUrl, `${server.url}/v1`);
		assert.deepEqual(server.paths(), ["/v1/models"]);
	});

	it("finds /v1/models when given the server root", async () => {
		const server = await serveList(list(["gpt-4o"]), "/v1");
		const result = await probeModels(server.url);
		assert.deepEqual(result.ids, ["gpt-4o"]);
		assert.equal(result.baseUrl, `${server.url}/v1`);
	});

	it("finds /models at the root when given a /v1 base", async () => {
		const server = await serveList(list(["gpt-4o"]), "");
		const result = await probeModels(`${server.url}/v1`);
		assert.deepEqual(result.ids, ["gpt-4o"]);
		assert.equal(result.baseUrl, server.url);
	});

	it("skips a web console served at /models (HTML with status 200)", async () => {
		const server = await serve((req, res) => (req.url === "/v1/models" ? json(res, list(["gpt-4o"])) : html(res)));
		assert.equal((await probeModels(server.url)).baseUrl, `${server.url}/v1`);
	});

	it("skips a JSON answer that is not a model list", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/models") return json(res, { message: "ok", version: "1.2.3" });
			if (req.url === "/v1/models") return json(res, list(["gpt-4o", "gpt-4o-mini"]));
			notFound(res);
		});
		const result = await probeModels(server.url);
		assert.deepEqual(result.ids, ["gpt-4o", "gpt-4o-mini"]);
		assert.equal(result.baseUrl, `${server.url}/v1`);
	});

	for (const status of [401, 403, 405, 500, 502, 503]) {
		it(`tries the other base variant after a ${status} (a front proxy that only routes /v1)`, async () => {
			const server = await serve((req, res) => {
				if (req.url === "/v1/models") return json(res, list(["gpt-4o"]));
				res.writeHead(status, { "content-type": "text/html" });
				res.end(`<html>${status} from the front proxy</html>`);
			});
			const result = await probeModels(server.url, "sk-test");
			assert.deepEqual(result.ids, ["gpt-4o"]);
			assert.equal(result.baseUrl, `${server.url}/v1`);
		});
	}

	it("prefers a variant with models over one that answers with an empty list", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/models") return json(res, { data: [] });
			if (req.url === "/v1/models") return json(res, list(["real-model"]));
			notFound(res);
		});
		const result = await probeModels(server.url);
		assert.deepEqual(result.ids, ["real-model"]);
		assert.equal(result.baseUrl, `${server.url}/v1`);
	});

	it("returns an empty result when the gateway really has no models", async () => {
		const server = await serveList({ object: "list", data: [] });
		const result = await probeModels(`${server.url}/v1`);
		assert.deepEqual(result.ids, []);
		assert.equal(result.baseUrl, `${server.url}/v1`);
	});
});

describe("probeModels — list shapes", () => {
	it("reads a bare array", async () => {
		const server = await serveList([{ id: "a" }, { id: "b" }]);
		assert.deepEqual((await probeModels(`${server.url}/v1`)).ids, ["a", "b"]);
	});

	it("reads plain string entries", async () => {
		const server = await serveList({ data: ["gpt-4o", "claude-sonnet-4-5"] });
		assert.deepEqual((await probeModels(`${server.url}/v1`)).ids, ["claude-sonnet-4-5", "gpt-4o"]);
	});

	it("reads a nested { data: { data: [...] } } envelope", async () => {
		const server = await serveList({ success: true, data: { data: [{ id: "nested" }] } });
		assert.deepEqual((await probeModels(`${server.url}/v1`)).ids, ["nested"]);
	});

	it("reads Google's native list and strips the models/ prefix", async () => {
		const server = await serveList(
			{ models: [{ name: "models/gemini-2.5-pro", inputTokenLimit: 1048576, outputTokenLimit: 65536, thinking: true }] },
			"/v1beta",
		);
		const result = await probeModels(`${server.url}/v1beta`, "key");
		assert.deepEqual(result.ids, ["gemini-2.5-pro"]);
		assert.deepEqual(result.infoById.get("gemini-2.5-pro"), { contextWindow: 1048576, maxTokens: 65536, reasoning: true });
	});

	it("follows Gemini-style pagination (nextPageToken)", async () => {
		const all = Array.from({ length: 120 }, (_, i) => ({ name: `models/gemini-x-${String(i).padStart(3, "0")}` }));
		const server = await serve((req, res) => {
			const url = new URL(req.url ?? "", "http://x");
			if (url.pathname !== "/v1beta/models") return notFound(res);
			const size = Number(url.searchParams.get("pageSize") ?? 50);
			const start = Number(url.searchParams.get("pageToken") ?? 0);
			json(res, { models: all.slice(start, start + size), ...(start + size < all.length ? { nextPageToken: String(start + size) } : {}) });
		});
		const result = await probeModels(`${server.url}/v1beta`, "key");
		assert.equal(result.ids.length, 120);
		assert.equal(server.hits.length, 2, "one request for the first page, one for the rest");
	});

	it("follows Anthropic-style pagination (has_more / last_id)", async () => {
		const all = Array.from({ length: 45 }, (_, i) => ({ type: "model", id: `claude-${String(i).padStart(2, "0")}` }));
		const server = await serve((req, res) => {
			const url = new URL(req.url ?? "", "http://x");
			if (url.pathname !== "/v1/models") return notFound(res);
			const limit = Number(url.searchParams.get("limit") ?? 20);
			const after = url.searchParams.get("after_id");
			const start = after ? all.findIndex((model) => model.id === after) + 1 : 0;
			const page = all.slice(start, start + limit);
			json(res, { data: page, has_more: start + limit < all.length, first_id: page[0]?.id, last_id: page.at(-1)?.id });
		});
		assert.equal((await probeModels(`${server.url}/v1`)).ids.length, 45);
	});

	it("stops paginating when a server keeps handing out the same page", async () => {
		const server = await serve((req, res) => json(res, { models: [{ name: "models/loop" }], nextPageToken: "again" }));
		const result = await probeModels(`${server.url}/v1beta`);
		assert.deepEqual(result.ids, ["loop"]);
		assert.ok(server.hits.length <= 25, `asked ${server.hits.length} times`);
	});
});

describe("probeModels — failures say what went wrong", () => {
	it("reports an error envelope delivered with status 200", async () => {
		const server = await serve((_req, res) => json(res, { success: false, message: "无效的令牌 (invalid token)" }));
		await assert.rejects(probeModels(`${server.url}/v1`, "sk-bad"), /answered with an error: 无效的令牌/);
	});

	it("reports an OpenAI-style error object delivered with status 200", async () => {
		const server = await serve((_req, res) => json(res, { error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
		await assert.rejects(probeModels(`${server.url}/v1`, "sk-bad"), /Incorrect API key provided/);
	});

	it("reports the auth failure, not the 404 of the other variant", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/v1/models") return json(res, { error: { message: "Invalid API key" } }, 401);
			notFound(res);
		});
		await assert.rejects(probeModels(`${server.url}/v1`, "sk-bad"), (error: Error) => {
			assert.match(error.message, /401/);
			assert.match(error.message, /Invalid API key/);
			return true;
		});
	});

	it("names every URL it tried when nothing is there", async () => {
		const server = await serve((_req, res) => notFound(res));
		await assert.rejects(probeModels(server.url), (error: Error) => {
			assert.match(error.message, /404 Not Found/);
			assert.ok(error.message.includes(`${server.url}/models`), error.message);
			assert.ok(error.message.includes(`${server.url}/v1/models`), error.message);
			return true;
		});
	});

	it("explains a connection failure instead of a bare 'fetch failed'", async () => {
		const server = await serve((_req, res) => notFound(res));
		const dead = server.url;
		await server.close();
		await assert.rejects(probeModels(`${dead}/v1`), (error: Error) => {
			assert.doesNotMatch(error.message, /^fetch failed$/);
			assert.match(error.message, /could not connect|ECONNREFUSED/i);
			assert.ok(error.message.includes(dead), error.message);
			return true;
		});
	});

	it("rejects input that is not a URL before any request is made", async () => {
		await assert.rejects(probeModels(""), /empty/i);
		await assert.rejects(probeModels("ftp://example.com/v1"), /http:\/\/ or https:\/\//);
	});
});

describe("probeModels — input forgiveness", () => {
	it("accepts a base without a scheme", async () => {
		const server = await serveList(list(["gpt-4o"]));
		assert.equal((await probeModels(`127.0.0.1:${server.port}`)).baseUrl, `${server.url}/v1`);
		assert.equal((await probeModels(`localhost:${server.port}/v1`)).baseUrl, `http://localhost:${server.port}/v1`);
	});

	it("accepts a pasted endpoint URL", async () => {
		const server = await serveList(list(["gpt-4o"]));
		for (const pasted of ["/v1/chat/completions", "/v1/models", "/v1/", "/v1?api-version=2024-10-21", "/v1/responses"]) {
			assert.equal((await probeModels(`${server.url}${pasted}`)).baseUrl, `${server.url}/v1`, pasted);
		}
	});
});

describe("probeModels — timeouts", () => {
	it("gives up on a server that never sends headers", async () => {
		const server = await serve(() => {
			/* never answers */
		});
		const started = Date.now();
		await assert.rejects(probeModels(`${server.url}/v1`), /timed out/);
		assert.ok(Date.now() - started < 3000, "bounded by the probe timeout, not hanging");
	});

	it("gives up on a body that stalls after the headers", async () => {
		const server = await serve((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.write('{"object":"list","data":[{"id":"gpt-4o"}'); // never finished
		});
		const started = Date.now();
		await assert.rejects(probeModels(`${server.url}/v1`), /timed out/);
		assert.ok(Date.now() - started < 3000);
	});

	it("still reads a large list that arrives slowly but steadily", async () => {
		const body = JSON.stringify(list(Array.from({ length: 400 }, (_, i) => `model-${i}`)));
		const server = await serve((req, res) => {
			if (req.url !== "/v1/models") return notFound(res);
			res.writeHead(200, { "content-type": "application/json" });
			// Ten chunks, 150 ms apart: 1.5 s in total, far beyond the 400 ms
			// patience, but never silent for that long.
			const size = Math.ceil(body.length / 10);
			let sent = 0;
			const timer = setInterval(() => {
				res.write(body.slice(sent, sent + size));
				sent += size;
				if (sent >= body.length) {
					clearInterval(timer);
					res.end();
				}
			}, 150);
		});
		assert.equal((await probeModels(`${server.url}/v1`)).ids.length, 400);
	});

	it("asks the remaining variants at once after a timeout, and finds the one that works", async () => {
		// /v1/models hangs (some LiteLLM deployments); /models at the root answers.
		const server = await serve((req, res) => {
			if (req.url === "/models") return json(res, list(["gpt-4o"]));
			/* /v1/models: silence */
		});
		const result = await probeModels(`${server.url}/v1`);
		assert.equal(result.baseUrl, server.url);
	});
});

describe("probeModels — https fallback for public http hosts", () => {
	it("falls back to https when nothing listens on plain http", async () => {
		const network = stubNetwork((url) => {
			if (url.protocol === "https:" && url.pathname === "/v1/models") return jsonResponse(list(["gpt-4o"]));
			return undefined; // http: connection refused
		});
		try {
			const result = await probeModels("http://gateway.example.com/v1");
			assert.equal(result.baseUrl, "https://gateway.example.com/v1");
			// The dead http origin is not asked a second time for the other path.
			assert.deepEqual(network.requested, ["http://gateway.example.com/v1/models", "https://gateway.example.com/v1/models"]);
		} finally {
			network.restore();
		}
	});

	it("tries both paths on the given scheme before switching scheme", async () => {
		const network = stubNetwork((url) => {
			if (url.protocol === "http:" && url.pathname === "/v1/models") return jsonResponse(list(["gpt-4o"]));
			if (url.protocol === "http:") return new Response("<html>console</html>", { status: 200 });
			return undefined;
		});
		try {
			const result = await probeModels("http://gateway.example.com:3000");
			assert.equal(result.baseUrl, "http://gateway.example.com:3000/v1");
			assert.deepEqual(network.requested, ["http://gateway.example.com:3000/models", "http://gateway.example.com:3000/v1/models"]);
		} finally {
			network.restore();
		}
	});

	it("does not invent an https variant for private hosts", async () => {
		const network = stubNetwork(() => undefined);
		try {
			for (const base of ["http://ollama:11434", "http://host.docker.internal:4000/v1", "http://100.64.0.7:8000/v1", "http://192.168.1.250:9/v1"]) {
				network.requested.length = 0;
				await assert.rejects(probeModels(base));
				assert.ok(
					network.requested.every((url) => url.startsWith("http://")),
					`${base} -> ${network.requested.join(", ")}`,
				);
			}
		} finally {
			network.restore();
		}
	});
});

describe("probeModels — redirects and the API key", () => {
	it("keeps the key on a same-origin redirect and reports the base that finally answered", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/v1/models") {
				res.writeHead(307, { location: "/api/v1/models" });
				return res.end();
			}
			if (req.url === "/api/v1/models") {
				return req.headers.authorization === "Bearer sk-valid" ? json(res, list(["gpt-4o"])) : json(res, { error: "no key" }, 401);
			}
			notFound(res);
		});
		const result = await probeModels(`${server.url}/v1`, "sk-valid");
		assert.deepEqual(result.ids, ["gpt-4o"]);
		assert.equal(result.baseUrl, `${server.url}/api/v1`);
	});

	it("never forwards the key to another host or port, and says so", async () => {
		const target = await serve((req, res) => {
			if (req.url !== "/v1/models") return notFound(res);
			if (!req.headers.authorization && !req.headers["x-goog-api-key"] && !req.headers["x-api-key"]) {
				return json(res, { error: { message: "You didn't provide an API key." } }, 401);
			}
			json(res, list(["leaked"]));
		});
		const front = await serve((req, res) => {
			res.writeHead(301, { location: `${target.url}${req.url}` });
			res.end();
		});
		await assert.rejects(probeModels(`${front.url}/v1`, "sk-secret"), /not forwarded to another host/);
		for (const hit of target.hits) {
			assert.equal(hit.headers.authorization, undefined);
			assert.equal(hit.headers["x-goog-api-key"], undefined);
			assert.equal(hit.headers["x-api-key"], undefined);
		}
	});

	it("follows a redirect to another host when no key is involved", async () => {
		const target = await serveList(list(["public-model"]));
		const front = await serve((req, res) => {
			res.writeHead(302, { location: `${target.url}${req.url}` });
			res.end();
		});
		const result = await probeModels(`${front.url}/v1`);
		assert.deepEqual(result.ids, ["public-model"]);
		assert.equal(result.baseUrl, `${target.url}/v1`);
	});

	it("forwards the key only where that is safe", () => {
		const may = (from: string, to: string) => mayForwardCredentials(new URL(from), new URL(to));
		assert.equal(may("http://api.example.com/v1/models", "https://api.example.com/v1/models"), true, "http -> https upgrade");
		assert.equal(may("https://api.example.com/v1/models", "https://api.example.com/api/v1/models"), true, "same origin");
		assert.equal(may("https://api.example.com/x", "http://api.example.com/x"), false, "https -> http downgrade");
		assert.equal(may("https://api.example.com/x", "https://evil.example.net/x"), false, "another host");
		assert.equal(may("https://api.example.com/x", "https://api.example.com:8443/x"), false, "another port");
		assert.equal(may("http://api.example.com:8080/x", "https://api.example.com/x"), false, "non-default port to https");
		assert.equal(may("https://example.com/x", "https://api.example.com/x"), false, "subdomain");
	});
});

describe("probeModels — ports fetch() refuses", () => {
	// The Fetch standard blocks these ports outright; a local gateway may still use one.
	async function onBlockedPort(handler: Parameters<typeof serve>[0]) {
		for (const port of [10080, 6000, 6666, 6667]) {
			try {
				return await serve(handler, { port });
			} catch {
				// in use on this machine — try the next one
			}
		}
		return undefined;
	}

	it("probes a gateway on such a port, with redirects, auth and POST working as usual", async (t) => {
		const server = await onBlockedPort((req, res, { body }) => {
			if (req.url === "/models") {
				res.writeHead(308, { location: "/v1/models" });
				return res.end();
			}
			if (req.url === "/v1/models") {
				return req.headers.authorization === "Bearer sk-test" ? json(res, list(["on-a-blocked-port"])) : json(res, { error: { message: "no key" } }, 401);
			}
			if (req.url === "/v1/chat/completions" && JSON.parse(body).messages[0].role === "developer") {
				return json(res, { choices: [{ message: { role: "assistant", content: "ok" } }] });
			}
			notFound(res);
		});
		if (!server) return t.skip("no blocked port is free on this machine");
		const result = await probeModels(server.url, "sk-test");
		assert.deepEqual(result.ids, ["on-a-blocked-port"]);
		assert.equal(result.baseUrl, `${server.url}/v1`);
		assert.equal(await probeDeveloperRole(`${server.url}/v1`, "sk-test", "on-a-blocked-port"), true);
		await server.close();
	});

	it("still times out on such a port", async (t) => {
		const server = await onBlockedPort(() => {});
		if (!server) return t.skip("no blocked port is free on this machine");
		await assert.rejects(probeModels(`${server.url}/v1`), /timed out/);
		await server.close();
	});
});

describe("probeModels — which header carries the key", () => {
	it("sends only Authorization: Bearer to an OpenAI-compatible gateway", async () => {
		resetAuthSchemeCache();
		const server = await serveList(list(["gpt-4o"]));
		await probeModels(`${server.url}/v1`, "sk-test");
		assert.equal(server.hits[0].headers.authorization, "Bearer sk-test");
		assert.equal(server.hits[0].headers["x-goog-api-key"], undefined);
		assert.equal(server.hits[0].headers["x-api-key"], undefined);
	});

	it("sends no credential header at all without a key", async () => {
		const server = await serveList(list(["gpt-4o"]));
		await probeModels(`${server.url}/v1`);
		assert.equal(server.hits[0].headers.authorization, undefined);
	});

	it("uses x-goog-api-key alone for Google's native API (a Bearer header makes Google answer 401)", async () => {
		resetAuthSchemeCache();
		const seen: Array<Record<string, string | undefined>> = [];
		const network = stubNetwork((url, init) => {
			const headers = new Headers(init?.headers);
			seen.push({ authorization: headers.get("authorization") ?? undefined, goog: headers.get("x-goog-api-key") ?? undefined });
			if (url.hostname !== "generativelanguage.googleapis.com") return undefined;
			// What the real API does: a Bearer header is read as an OAuth token.
			if (headers.get("authorization")) return jsonResponse({ error: { code: 401, message: "Request had invalid authentication credentials." } }, 401);
			if (headers.get("x-goog-api-key") !== "AIza-valid") return jsonResponse({ error: { code: 400, message: "API key not valid." } }, 400);
			return jsonResponse({ models: [{ name: "models/gemini-2.5-pro" }] });
		});
		try {
			const result = await probeModels("https://generativelanguage.googleapis.com/v1beta", "AIza-valid");
			assert.deepEqual(result.ids, ["gemini-2.5-pro"]);
			assert.deepEqual(seen, [{ authorization: undefined, goog: "AIza-valid" }]);
		} finally {
			network.restore();
		}
	});

	it("retries with x-goog-api-key on a relay that re-exposes the Gemini-native surface", async () => {
		resetAuthSchemeCache();
		const server = await serve((req, res) => {
			if (req.url !== "/v1beta/models") return notFound(res);
			if (req.headers["x-goog-api-key"] === "relay-key") return json(res, { models: [{ name: "models/gemini-2.5-flash" }] });
			json(res, { error: { message: "missing api key" } }, 401);
		});
		const result = await probeModels(`${server.url}/v1beta`, "relay-key");
		assert.deepEqual(result.ids, ["gemini-2.5-flash"]);
		// The scheme that worked is remembered for this origin.
		server.hits.length = 0;
		await probeModels(`${server.url}/v1beta`, "relay-key");
		assert.equal(server.hits.length, 1);
		assert.equal(server.hits[0].headers["x-goog-api-key"], "relay-key");
	});

	it("retries with x-api-key when the refusal names that header", async () => {
		resetAuthSchemeCache();
		const server = await serve((req, res) => {
			if (req.url !== "/v1/models") return notFound(res);
			if (req.headers["x-api-key"] === "sk-ant") return json(res, { data: [{ type: "model", id: "claude-sonnet-4-5" }], has_more: false });
			json(res, { type: "error", error: { type: "authentication_error", message: "x-api-key header is required" } }, 401);
		});
		const result = await probeModels(`${server.url}/v1`, "sk-ant");
		assert.deepEqual(result.ids, ["claude-sonnet-4-5"]);
		assert.equal(server.hits[1].headers["anthropic-version"], "2023-06-01");
	});

	it("does not try other headers on an ordinary gateway that refuses the key", async () => {
		resetAuthSchemeCache();
		const server = await serve((req, res) => (req.url === "/v1/models" ? json(res, { error: { message: "Invalid token" } }, 401) : notFound(res)));
		await assert.rejects(probeModels(`${server.url}/v1`, "sk-bad"), /Invalid token/);
		const listRequests = server.hits.filter((hit) => hit.url === "/v1/models");
		assert.equal(listRequests.length, 1);
		assert.equal(listRequests[0].headers.authorization, "Bearer sk-bad");
	});
});
