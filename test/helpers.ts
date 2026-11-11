// Shared test plumbing: a scriptable mock gateway, real /models payloads as
// fixtures, and environment isolation.
//
// This file must NOT import the library statically: isolateEnvironment() has
// to run before the library is loaded (it reads its timeout once, at load).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..");

export type Hit = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

export type MockServer = {
	port: number;
	/** http://127.0.0.1:<port> */
	url: string;
	hits: Hit[];
	/** Request paths seen so far, in order. */
	paths(): string[];
	close(): Promise<void>;
};

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, ctx: { body: string; hits: Hit[] }) => void;

const openServers = new Set<MockServer>();

// Unprivileged ports that fetch() refuses to talk to (the Fetch standard's
// "bad ports"). A mock server must not land on one by chance.
const FETCH_BLOCKED = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

function listen(server: http.Server, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve((server.address() as import("node:net").AddressInfo).port);
		});
	});
}

/** Start a mock gateway on a random local port (or on `options.port`). */
export async function serve(handler: Handler, options: { port?: number } = {}): Promise<MockServer> {
	const hits: Hit[] = [];
	const sockets = new Set<import("node:net").Socket>();
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
			handler(req, res, { body, hits });
		});
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	let port = await listen(server, options.port ?? 0);
	while (options.port === undefined && FETCH_BLOCKED.has(port)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		port = await listen(server, 0);
	}
	const mock: MockServer = {
		port,
		url: `http://127.0.0.1:${port}`,
		hits,
		paths: () => hits.map((hit) => hit.url),
		close: () =>
			new Promise<void>((resolve) => {
				openServers.delete(mock);
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
			}),
	};
	openServers.add(mock);
	return mock;
}

/** Close every mock server a test left open. */
export async function closeAllServers(): Promise<void> {
	await Promise.all([...openServers].map((server) => server.close()));
}

export function json(res: http.ServerResponse, body: unknown, status = 200): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

export function notFound(res: http.ServerResponse): void {
	res.writeHead(404, { "content-type": "text/plain" });
	res.end("404 page not found");
}

export function html(res: http.ServerResponse, status = 200): void {
	res.writeHead(status, { "content-type": "text/html" });
	res.end("<!doctype html><html><body>console</body></html>");
}

/** An OpenAI-style list body from ids or full entries. */
export function list(entries: Array<string | Record<string, unknown>>): { object: string; data: unknown[] } {
	return { object: "list", data: entries.map((entry) => (typeof entry === "string" ? { id: entry, object: "model" } : entry)) };
}

/** A gateway that serves `body` at GET <prefix>/models and 404 elsewhere. */
export function serveList(body: unknown, prefix = "/v1"): Promise<MockServer> {
	return serve((req, res) => (req.url === `${prefix}/models` ? json(res, body) : notFound(res)));
}

/** A captured real-world /models response (see test/fixtures/lists). */
export function fixture(name: string): any {
	return JSON.parse(readFileSync(join(HERE, "fixtures", "lists", `${name}.json`), "utf8")).payload;
}

const tempDirs: string[] = [];

/** A fresh temp directory, removed when the test process exits. */
export function tempDir(prefix = "model-probe-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

process.on("exit", () => {
	for (const dir of tempDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
});

/**
 * Point the library away from the developer's real files and shorten its
 * patience so timeout tests take milliseconds. Call before importing it.
 */
export function isolateEnvironment(options: { timeoutMs?: number } = {}): { cacheDir: string } {
	const cacheDir = tempDir("model-probe-cache-");
	process.env.MODEL_PROBE_CACHE_DIR = cacheDir;
	// A path that does not exist: no user rules file is picked up.
	process.env.MODEL_PROBE_RULES = join(cacheDir, "no-user-rules.json");
	process.env.MODEL_PROBE_TIMEOUT_MS = String(options.timeoutMs ?? 400);
	return { cacheDir };
}

/** The environment for a spawned CLI: isolated, and with no proxy inherited from the developer's shell. */
export function childEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const name of Object.keys(env)) {
		if (/^(https?_proxy|no_proxy|all_proxy|node_use_env_proxy|model_probe_api_key)$/i.test(name)) delete env[name];
	}
	const cacheDir = tempDir("model-probe-cache-");
	return { ...env, MODEL_PROBE_CACHE_DIR: cacheDir, MODEL_PROBE_RULES: join(cacheDir, "no-user-rules.json"), ...extra };
}

// ---------------------------------------------------------------------------
// Network stubbing
//
// Tests never touch the real network. Requests to the local mock servers pass
// through; everything else is answered by `route` or refused.

type Route = (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

const realFetch = globalThis.fetch;

/** Replace global fetch. Returns the list of external URLs that were asked for. */
export function stubNetwork(route: Route = () => undefined): { requested: string[]; restore(): void } {
	const requested: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
		if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
		requested.push(url.toString());
		const response = await route(url, init);
		if (response) return response;
		const error = new TypeError("fetch failed");
		(error as any).cause = Object.assign(new Error(`connect ECONNREFUSED ${url.host}`), { code: "ECONNREFUSED" });
		throw error;
	}) as typeof fetch;
	return {
		requested,
		restore: () => {
			globalThis.fetch = realFetch;
		},
	};
}

export function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A models.dev SDK snapshot module, in the exact format the SDK publishes. */
export function snapshotModule(catalog: unknown, generatedAt = "2026-11-10T05:24:22.418Z"): string {
	return [
		"// Generated by script/generate.ts. Do not edit; run `bun run generate` in packages/sdk.",
		`const data = /* @__PURE__ */ JSON.parse(${JSON.stringify(JSON.stringify(catalog))})`,
		"export const providers = data.providers",
		"export const models = data.models",
		`export const generatedAt = ${JSON.stringify(generatedAt)}`,
		"export default data",
		"",
	].join("\n");
}

type CatalogModel = { context: number; output: number; input?: string[]; reasoning?: boolean; cost?: Record<string, number>; canonical?: string };

function providerModel(id: string, model: CatalogModel): Record<string, unknown> {
	return {
		id,
		name: id,
		description: "",
		attachment: false,
		tool_call: true,
		release_date: "2026-01-01",
		last_updated: "2026-01-01",
		open_weights: false,
		reasoning: model.reasoning ?? false,
		modalities: { input: model.input ?? ["text"], output: ["text"] },
		limit: { context: model.context, output: model.output },
		...(model.cost ? { cost: model.cost } : {}),
		...(model.canonical ? { canonical_model_id: model.canonical } : {}),
	};
}

/** Build a provider entry for a fake models.dev catalog. */
export function catalogProvider(id: string, api: string | undefined, models: Record<string, CatalogModel>): Record<string, unknown> {
	return {
		id,
		name: id,
		env: [`${id.toUpperCase()}_API_KEY`],
		npm: "@ai-sdk/openai-compatible",
		...(api ? { api } : {}),
		models: Object.fromEntries(Object.entries(models).map(([modelId, model]) => [modelId, providerModel(modelId, model)])),
	};
}

/** Build a lab ("as published by the maker") entry for a fake models.dev catalog. */
export function labModel(id: string, model: { context: number; output?: number; input?: string[]; reasoning?: boolean; openWeights?: boolean }): Record<string, unknown> {
	return {
		id,
		name: id,
		description: "",
		reasoning: model.reasoning ?? false,
		open_weights: model.openWeights ?? false,
		modalities: { input: model.input ?? ["text"], output: ["text"] },
		limit: { context: model.context, ...(model.output !== undefined ? { output: model.output } : {}) },
	};
}
