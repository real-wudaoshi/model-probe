// The command-line interface, run as a real child process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { catalogProvider, childEnvironment, closeAllServers, json, list, notFound, REPO_ROOT, serve } from "./helpers.ts";

after(closeAllServers);

const CLI = join(REPO_ROOT, "cli.ts");
const VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;

type Run = { code: number | null; stdout: string; stderr: string; elapsedMs: number; idleTailMs: number };

/** Run the CLI and wait for it to exit. `idleTailMs` is how long it lingered after its last output. */
function run(args: string[], env: NodeJS.ProcessEnv = childEnvironment()): Promise<Run> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		let lastOutput = started;
		let stdout = "";
		let stderr = "";
		const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			lastOutput = Date.now();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			lastOutput = Date.now();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - started, idleTailMs: Date.now() - lastOutput }));
	});
}

/** A child environment whose models.dev tier is answered from a pre-seeded disk cache (no network). */
function environmentWithCatalog(providers: Record<string, unknown>): NodeJS.ProcessEnv {
	const env = childEnvironment();
	writeFileSync(join(env.MODEL_PROBE_CACHE_DIR!, "modelsdev-live.json"), JSON.stringify({ savedAt: Date.now(), asOf: Date.now(), providers, models: {} }));
	return env;
}

const bareGateway = () =>
	serve((req, res) =>
		req.url === "/v1/models" ? json(res, list(["gpt-4o", "catalog-model", { id: "described-model", context_length: 4096 }, "totally-unknown-model-xyz"])) : notFound(res),
	);

describe("usage", () => {
	it("prints help and exits 0", async () => {
		for (const flag of ["--help", "-h"]) {
			const result = await run([flag]);
			assert.equal(result.code, 0);
			assert.match(result.stdout, /^Usage: model-probe <baseUrl>/);
			assert.equal(result.stderr, "");
		}
	});

	it("prints its version", async () => {
		const result = await run(["--version"]);
		assert.equal(result.code, 0);
		assert.equal(result.stdout.trim(), VERSION);
	});

	it("fails with exit code 2 when used wrongly, and says why on stderr", async () => {
		const cases: Array<[string[], RegExp]> = [
			[[], /Missing <baseUrl>/],
			[["--bogus", "http://127.0.0.1:1"], /Unknown option: --bogus/],
			[["http://127.0.0.1:1", "http://127.0.0.1:2"], /Unexpected argument: http:\/\/127\.0\.0\.1:2/],
			[["http://127.0.0.1:1", "--key"], /--key needs a value/],
			[["http://127.0.0.1:1", "--api", "--json"], /--api needs a value/],
		];
		for (const [args, message] of cases) {
			const result = await run(args);
			assert.equal(result.code, 2, args.join(" "));
			assert.match(result.stderr, message);
			assert.match(result.stderr, /Usage: model-probe/);
			assert.equal(result.stdout, "", "nothing on stdout that a pipe could mistake for a result");
		}
	});
});

describe("probing", () => {
	it("lists models with their metadata and says where it came from", async () => {
		const server = await bareGateway();
		const env = environmentWithCatalog({
			somehost: catalogProvider("somehost", "https://somehost.example/v1", { "catalog-model": { context: 500000, output: 20000, input: ["text", "image"] } }),
		});
		const result = await run([`${server.url}/v1`], env);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stderr, "");
		const lines = result.stdout.split("\n");
		assert.equal(lines[0], `Base URL: ${server.url}/v1`);
		assert.equal(lines[1], "Models:   4");
		assert.ok(lines.includes("  catalog-model — ctx 500000 [models.dev] • max-out 20000 [models.dev] • image [models.dev] • no reasoning [models.dev]"), result.stdout);
		assert.ok(lines.includes("  described-model — ctx 4096"), result.stdout);
		assert.ok(lines.includes("  gpt-4o — ctx 128000 [local rules] • image [local rules]"), result.stdout);
		assert.ok(lines.includes("  totally-unknown-model-xyz"), result.stdout);
		// One model per source — the catalog's contribution is not counted as "detected".
		assert.match(result.stdout, /Metadata: 1 from the gateway, 1 from models\.dev, 1 from local rules, 1 defaults only/);
	});

	it("accepts --key value and --key=value, and MODEL_PROBE_API_KEY", async () => {
		const server = await serve((req, res) => {
			if (req.url !== "/v1/models") return notFound(res);
			return req.headers.authorization === "Bearer sk-cli" ? json(res, list(["only-with-key"])) : json(res, { error: { message: "missing key" } }, 401);
		});
		for (const args of [["--key", "sk-cli"], ["--key=sk-cli"]]) {
			const result = await run([`${server.url}/v1`, "--no-fallback", ...args]);
			assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
			assert.match(result.stdout, /only-with-key/);
		}
		const fromEnv = await run([`${server.url}/v1`, "--no-fallback"], childEnvironment({ MODEL_PROBE_API_KEY: "sk-cli" }));
		assert.equal(fromEnv.code, 0, fromEnv.stderr);
		const without = await run([`${server.url}/v1`, "--no-fallback"]);
		assert.equal(without.code, 1);
		assert.match(without.stderr, /401/);
	});

	it("with --no-fallback shows only what the gateway reported, and says so", async () => {
		const server = await bareGateway();
		const result = await run([`${server.url}/v1`, "--no-fallback"]);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(result.stdout.includes("  described-model — ctx 4096"));
		assert.ok(result.stdout.split("\n").includes("  gpt-4o"), "no rule-based guess");
		assert.match(result.stdout, /Metadata: 1 reported by the gateway, 3 without metadata \(fallbacks are off\)/);
	});

	it("warns about an unknown --api flavor instead of silently ignoring it", async () => {
		const server = await bareGateway();
		const typo = await run([`${server.url}/v1`, "--no-fallback", "--api", "openai"]);
		assert.equal(typo.code, 0);
		assert.match(typo.stderr, /unknown --api flavor "openai".*openai-completions/);
		const fine = await run([`${server.url}/v1`, "--no-fallback", "--api=openai-completions"]);
		assert.equal(fine.stderr, "");
	});

	it("reports the developer-role probe", async () => {
		const server = await serve((req, res) => {
			if (req.url === "/v1/models") return json(res, list(["gpt-4o"]));
			if (req.url === "/v1/chat/completions") return json(res, { error: { message: "role 'developer' is not allowed" } }, 400);
			notFound(res);
		});
		const text = await run([`${server.url}/v1`, "--no-fallback", "--developer-role"]);
		assert.match(text.stdout, /^Developer role: NOT supported$/m);
		const asJson = JSON.parse((await run([`${server.url}/v1`, "--no-fallback", "--developer-role", "--json"])).stdout);
		assert.equal(asJson.supportsDeveloperRole, false);
		assert.equal(asJson.developerRoleSource, "detected");
	});

	it("exits promptly once the result is printed", async () => {
		const server = await bareGateway();
		const result = await run([`${server.url}/v1`, "--no-fallback"]);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(result.idleTailMs < 1000, `lingered ${result.idleTailMs}ms after its last output`);
	});

	it("does not let a gateway inject terminal escape sequences through model ids", async () => {
		const server = await serve((req, res) => (req.url === "/v1/models" ? json(res, list(["evil\u001b[2J\u001b]0;pwned\u0007model"])) : notFound(res)));
		const result = await run([`${server.url}/v1`, "--no-fallback"]);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(!result.stdout.includes("\u001b"), "no raw escape character on the terminal");
		assert.ok(!result.stdout.includes("\u0007"));
		assert.match(result.stdout, /evil\?\[2J\?\]0;pwned\?model/);
	});
});

describe("--json", () => {
	it("prints one JSON document with ids, models and the resolved base", async () => {
		const server = await bareGateway();
		const result = await run([server.url, "--no-fallback", "--json"]);
		assert.equal(result.code, 0, result.stderr);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.baseUrl, `${server.url}/v1`);
		assert.deepEqual(parsed.ids, ["catalog-model", "described-model", "gpt-4o", "totally-unknown-model-xyz"]);
		assert.deepEqual(parsed.models, { "described-model": { contextWindow: 4096 } });
		assert.ok(!("supportsDeveloperRole" in parsed));
	});

	it("delivers a large result through a pipe in full", async () => {
		const big = Array.from({ length: 3000 }, (_, i) => ({ id: `provider-${i % 37}/some-long-model-name-${i}`, context_length: 128000 + i, pricing: { prompt: "0.000001", completion: "0.000002" } }));
		const server = await serve((req, res) => (req.url === "/v1/models" ? json(res, { data: big }) : notFound(res)));
		const result = await run([`${server.url}/v1`, "--no-fallback", "--json"]);
		assert.equal(result.code, 0, result.stderr);
		assert.ok(result.stdout.length > 300_000, `only ${result.stdout.length} bytes arrived`);
		assert.equal(JSON.parse(result.stdout).ids.length, 3000);
	});
});

describe("failures", () => {
	it("exits 1 with a one-line reason on stderr and nothing on stdout", async () => {
		const server = await serve((_req, res) => json(res, { error: { message: "Invalid API key" } }, 401));
		const result = await run([`${server.url}/v1`, "--key", "sk-bad", "--json"]);
		assert.equal(result.code, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^Probe failed \(401 Unauthorized\) at .*Invalid API key/);
		assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
	});

	it("explains an unreachable gateway", async () => {
		const server = await bareGateway();
		const dead = server.url;
		await server.close();
		const result = await run([`${dead}/v1`]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /^Probe failed: could not connect to /);
		assert.doesNotMatch(result.stderr, /Probe failed: Probe failed/);
	});

	it("rejects a base URL it cannot read", async () => {
		const result = await run(["ftp://example.com"]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /Probe failed: Unsupported URL scheme/);
	});
});

// Node's fetch only honors HTTP(S)_PROXY from Node 22.21 / 24 on.
const [major, minor] = process.versions.node.split(".").map(Number);
const envProxySupported = !process.versions.bun && (major >= 24 || (major === 22 && minor >= 21));

describe("proxy", { skip: envProxySupported ? false : "this Node version's fetch cannot use HTTP_PROXY" }, () => {
	/** A forward proxy that answers for "gateway.example.com" itself and records what it was asked. */
	async function fakeProxy() {
		const asked: string[] = [];
		const answer = (req: http.IncomingMessage, res: http.ServerResponse) => {
			const path = new URL(req.url ?? "/", "http://gateway.example.com").pathname;
			asked.push(`${req.headers.host}${path}`);
			if (path === "/v1/models") return json(res, list(["reached-through-the-proxy"]));
			notFound(res);
		};
		// Reached either with an absolute-URI request or through a CONNECT tunnel.
		const inner = http.createServer(answer);
		const proxy = http.createServer(answer);
		proxy.on("connect", (_req, socket) => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			inner.emit("connection", socket);
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const port = (proxy.address() as import("node:net").AddressInfo).port;
		return { url: `http://127.0.0.1:${port}`, asked, close: () => new Promise<void>((resolve) => (proxy.closeAllConnections(), proxy.close(() => resolve()))) };
	}

	it("sends requests for a public gateway through HTTP_PROXY", async () => {
		const proxy = await fakeProxy();
		try {
			// gateway.example.com does not exist: the only way to an answer is the proxy.
			const result = await run(["http://gateway.example.com/v1", "--no-fallback"], childEnvironment({ HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url }));
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /reached-through-the-proxy/);
			assert.ok(proxy.asked.includes("gateway.example.com/v1/models"), proxy.asked.join(", "));
		} finally {
			await proxy.close();
		}
	});

	it("still reaches a local gateway directly when a proxy is configured", async () => {
		const server = await bareGateway();
		// A proxy that refuses every connection: a local probe must not depend on it.
		const result = await run([`${server.url}/v1`, "--no-fallback"], childEnvironment({ HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1" }));
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /described-model/);
	});
});
