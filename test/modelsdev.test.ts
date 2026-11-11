// The models.dev tier: where the catalog comes from, how it is cached, and
// how model ids are looked up in it. No test here touches the real network.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { catalogProvider, isolateEnvironment, jsonResponse, labModel, snapshotModule, stubNetwork } from "./helpers.ts";

const { cacheDir } = isolateEnvironment();
const {
	fetchModelsDevInfoByModelIds,
	fetchModelsDevInfoForBaseUrl,
	fetchModelsDevModels,
	fetchModelsDevProviders,
	getModelsDevCatalogInfo,
	resetModelsDevCatalog,
} = await import("../index.ts");
const { parseSnapshotModule } = await import("../src/modelsdev.ts");

const LIVE_URL = "https://models.dev/catalog.json";
const CDN_HOST = "cdn.jsdelivr.net";

// A small catalog with the situations the id index has to get right.
const CATALOG = {
	providers: {
		makerco: catalogProvider("makerco", "https://api.makerco.example/v1", {
			"flagship-1": { context: 1000000, output: 64000, input: ["text", "image"], reasoning: true, canonical: "makerco/flagship-1", cost: { input: 3, output: 15, cache_read: 0.3 } },
		}),
		"reseller-a": catalogProvider("reseller-a", "https://a.example/v1", {
			"makerco/flagship-1": { context: 200000, output: 8000, input: ["text"], reasoning: true, canonical: "makerco/flagship-1", cost: { input: 9, output: 45 } },
			"openllama-70b": { context: 32768, output: 4096, canonical: "openlab/openllama-70b" },
			"mystery-model": { context: 8000, output: 1000 },
		}),
		"reseller-b": catalogProvider("reseller-b", "https://b.example", {
			"flagship-1": { context: 200000, output: 8000, input: ["text"], reasoning: true, canonical: "makerco/flagship-1" },
			"openllama-70b": { context: 32768, output: 4096, canonical: "openlab/openllama-70b" },
			"mystery-model": { context: 8000, output: 1000 },
			"degenerate-limits": { context: 100000, output: 100000 },
		}),
		"host-c": catalogProvider("host-c", "https://c.example/v1", {
			"openllama-70b": { context: 131072, output: 8192, canonical: "openlab/openllama-70b" },
		}),
		// No OpenAI-compatible endpoint in the catalog (a native API).
		google: catalogProvider("google", undefined, { "gemini-x": { context: 1048576, output: 65536, input: ["text", "image", "video"], reasoning: true } }),
	},
	models: {
		"makerco/flagship-1": labModel("makerco/flagship-1", { context: 1000000, output: 64000, input: ["text", "image"], reasoning: true }),
		"openlab/openllama-70b": labModel("openlab/openllama-70b", { context: 131072, output: 131072, openWeights: true }),
		"makerco/labonly-1": labModel("makerco/labonly-1", { context: 400000, output: 32000, input: ["text", "image"] }),
	},
};

// What the stubbed network does for the two catalog sources.
// "legacy": a deployment that serves api.json (provider tables) but no catalog.json.
let live: "ok" | "down" | "hang" | "legacy" = "ok";
let cdn: "ok" | "down" | "booby-trapped" = "ok";

const network = stubNetwork((url, init) => {
	if (url.toString() === "https://models.dev/api.json") return live === "legacy" ? jsonResponse(CATALOG.providers) : undefined;
	if (url.toString() === LIVE_URL) {
		if (live === "ok") return jsonResponse(CATALOG);
		if (live === "legacy") return new Response("Not Found", { status: 404 });
		if (live === "hang") {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
			});
		}
		return undefined;
	}
	if (url.hostname === CDN_HOST) {
		if (cdn === "down") return undefined;
		const module = snapshotModule(CATALOG);
		// A snapshot that would do something if it were ever run as code.
		return new Response(cdn === "booby-trapped" ? `globalThis.__MODEL_PROBE_SNAPSHOT_RAN = true;\n${module}` : module);
	}
	return undefined;
});
after(() => network.restore());

beforeEach(() => {
	live = "ok";
	cdn = "ok";
	network.requested.length = 0;
	for (const name of readdirSync(cacheDir)) rmSync(join(cacheDir, name), { force: true });
	resetModelsDevCatalog();
});

const liveRequests = () => network.requested.filter((url) => url.startsWith("https://models.dev/"));
const cdnRequests = () => network.requested.filter((url) => new URL(url).hostname === CDN_HOST);

describe("catalog sources", () => {
	it("downloads the live catalog once and reuses it within the session", async () => {
		assert.equal((await getModelsDevCatalogInfo()).source, "live");
		await fetchModelsDevProviders();
		await fetchModelsDevModels("makerco");
		await fetchModelsDevInfoByModelIds(["flagship-1"]);
		assert.deepEqual(liveRequests(), [LIVE_URL]);
	});

	it("shares one download between concurrent callers", async () => {
		await Promise.all([fetchModelsDevProviders(), fetchModelsDevModels("makerco"), fetchModelsDevInfoByModelIds(["flagship-1"]), getModelsDevCatalogInfo()]);
		assert.deepEqual(liveRequests(), [LIVE_URL]);
	});

	it("keeps the download on disk for the next process", async () => {
		await fetchModelsDevProviders();
		assert.ok(existsSync(join(cacheDir, "modelsdev-live.json")));
		resetModelsDevCatalog(); // a new process: nothing in memory
		network.requested.length = 0;
		live = "down";
		assert.equal((await getModelsDevCatalogInfo()).source, "cache");
		assert.equal((await fetchModelsDevModels("makerco")).get("flagship-1")?.contextWindow, 1000000);
		assert.deepEqual(network.requested, [], "served from disk, no request at all");
	});

	it("falls back to the CDN snapshot when models.dev is unreachable", async () => {
		live = "down";
		const info = await getModelsDevCatalogInfo();
		assert.equal(info.source, "cdn");
		assert.equal(new Date(info.asOf).toISOString(), "2026-11-10T05:24:22.418Z", "asOf is the snapshot's own date");
		assert.equal((await fetchModelsDevModels("makerco")).get("flagship-1")?.contextWindow, 1000000);
		assert.equal(cdnRequests().length, 1);
	});

	it("reads the CDN snapshot as data and never runs it", async () => {
		live = "down";
		cdn = "booby-trapped";
		assert.equal((await fetchModelsDevModels("makerco")).size, 1);
		assert.equal((globalThis as any).__MODEL_PROBE_SNAPSHOT_RAN, undefined);
		// Whatever is kept on disk is JSON, not a module.
		const files = readdirSync(cacheDir);
		assert.ok(files.includes("modelsdev-cdn.json"), files.join(", "));
		assert.ok(
			files.every((name) => !/\.(m?js|cjs|ts)$/.test(name)),
			files.join(", "),
		);
		JSON.parse(readFileSync(join(cacheDir, "modelsdev-cdn.json"), "utf8"));
	});

	it("falls back to the snapshot bundled with the SDK when fully offline", async () => {
		live = "down";
		cdn = "down";
		const info = await getModelsDevCatalogInfo();
		assert.equal(info.source, "bundled");
		assert.ok(info.asOf > Date.parse("2026-01-01"), "the bundled snapshot carries its generation date");
		assert.ok((await fetchModelsDevModels("openai")).size > 10, "real data from the installed SDK");
	});

	it("does not wait for an unreachable models.dev again on the next run", async () => {
		live = "down";
		await getModelsDevCatalogInfo();
		assert.equal(liveRequests().length, 1);
		resetModelsDevCatalog();
		network.requested.length = 0;
		assert.equal((await getModelsDevCatalogInfo()).source, "cdn");
		assert.deepEqual(liveRequests(), [], "the recent failure is remembered");
		assert.deepEqual(cdnRequests(), [], "and the CDN snapshot is cached too");
	});

	it("gives up on a hanging models.dev within its time budget", async () => {
		live = "hang";
		const started = Date.now();
		assert.equal((await getModelsDevCatalogInfo()).source, "cdn");
		assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
	});

	it("prefers a day-old live download over the CDN snapshot when models.dev is down", async () => {
		const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
		const older = { providers: { ...CATALOG.providers, "only-in-cache": catalogProvider("only-in-cache", "https://x.example/v1", {}) }, models: {} };
		writeFileSync(join(cacheDir, "modelsdev-live.json"), JSON.stringify({ savedAt: twoHoursAgo, asOf: twoHoursAgo, ...older }));
		live = "down";
		assert.equal((await getModelsDevCatalogInfo()).source, "cache");
		assert.ok((await fetchModelsDevProviders()).has("only-in-cache"));
		assert.deepEqual(cdnRequests(), []);
	});

	it("refreshes a live download that is more than an hour old", async () => {
		const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
		writeFileSync(join(cacheDir, "modelsdev-live.json"), JSON.stringify({ savedAt: twoHoursAgo, asOf: twoHoursAgo, providers: { stale: catalogProvider("stale", "https://x.example/v1", {}) }, models: {} }));
		assert.equal((await getModelsDevCatalogInfo()).source, "live");
		assert.ok(!(await fetchModelsDevProviders()).has("stale"));
	});

	it("ignores a corrupt cache file", async () => {
		writeFileSync(join(cacheDir, "modelsdev-live.json"), '{"savedAt": 1, "providers": {"trunc');
		assert.equal((await getModelsDevCatalogInfo()).source, "live");
		writeFileSync(join(cacheDir, "modelsdev-live.json"), JSON.stringify({ savedAt: Date.now(), providers: [] }));
		resetModelsDevCatalog();
		assert.equal((await getModelsDevCatalogInfo()).source, "live");
	});

	it("makes do with api.json where catalog.json does not exist", async () => {
		live = "legacy";
		assert.equal((await getModelsDevCatalogInfo()).source, "live");
		assert.deepEqual(liveRequests(), [LIVE_URL, "https://models.dev/api.json"]);
		assert.equal((await fetchModelsDevModels("makerco")).size, 1);
		// Without the lab metadata the id index falls back to the common value.
		assert.equal((await fetchModelsDevInfoByModelIds(["flagship-1"])).get("flagship-1")?.contextWindow, 200000);
	});

	it("works when the cache directory cannot be written", async () => {
		const previous = process.env.MODEL_PROBE_CACHE_DIR;
		// A path below a regular file can never be created.
		writeFileSync(join(cacheDir, "not-a-directory"), "");
		process.env.MODEL_PROBE_CACHE_DIR = join(cacheDir, "not-a-directory", "cache");
		try {
			assert.equal((await getModelsDevCatalogInfo()).source, "live");
			assert.equal((await fetchModelsDevModels("makerco")).size, 1);
			live = "down";
			resetModelsDevCatalog();
			assert.equal((await getModelsDevCatalogInfo()).source, "cdn", "no cache, no failure marker — still falls through cleanly");
		} finally {
			process.env.MODEL_PROBE_CACHE_DIR = previous;
		}
	});
});

describe("requireLive (for callers that sync against the catalog)", () => {
	it("is satisfied by live data and by this machine's own cache of it", async () => {
		assert.equal((await fetchModelsDevModels("makerco", { requireLive: true })).size, 1);
		resetModelsDevCatalog();
		live = "down";
		assert.equal((await fetchModelsDevModels("makerco", { requireLive: true })).size, 1);
	});

	it("refuses to answer from a published snapshot", async () => {
		live = "down";
		await assert.rejects(fetchModelsDevModels("makerco", { requireLive: true }), /models\.dev is unreachable.*2026-11-10/);
		cdn = "down";
		resetModelsDevCatalog();
		for (const name of readdirSync(cacheDir)) rmSync(join(cacheDir, name), { force: true });
		await assert.rejects(fetchModelsDevModels("openai", { requireLive: true }), /models\.dev is unreachable/);
		// The default stays lenient: metadata lookups work offline.
		assert.ok((await fetchModelsDevModels("openai")).size > 0);
	});
});

describe("provider tables", () => {
	it("lists only providers with an OpenAI-compatible endpoint", async () => {
		const providers = await fetchModelsDevProviders();
		assert.deepEqual([...providers.keys()].sort(), ["host-c", "makerco", "reseller-a", "reseller-b"]);
		assert.deepEqual(providers.get("makerco"), { id: "makerco", name: "makerco", baseUrl: "https://api.makerco.example/v1", env: ["MAKERCO_API_KEY"], doc: undefined });
	});

	it("returns a provider's models with limits, capabilities and list prices", async () => {
		assert.deepEqual((await fetchModelsDevModels("makerco")).get("flagship-1"), {
			contextWindow: 1000000,
			maxTokens: 64000,
			image: true,
			video: false,
			reasoning: true,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
		});
	});

	it("reads providers the catalog lists without an endpoint, too", async () => {
		assert.equal((await fetchModelsDevModels("google")).get("gemini-x")?.video, true);
	});

	it("clamps degenerate limits (output == context)", async () => {
		assert.equal((await fetchModelsDevModels("reseller-b")).get("degenerate-limits")?.maxTokens, 25000);
	});

	it("answers an unknown provider id with an empty table", async () => {
		for (const id of ["nope", "", "__proto__", "constructor", "toString", "hasOwnProperty"]) {
			assert.equal((await fetchModelsDevModels(id)).size, 0, id);
		}
	});
});

describe("lookup by base URL", () => {
	it("matches a provider's endpoint with or without the /v1 suffix", async () => {
		for (const base of ["https://api.makerco.example/v1", "https://api.makerco.example", "https://API.makerco.example/v1/", "https://b.example/v1"]) {
			assert.ok((await fetchModelsDevInfoForBaseUrl(base)).size > 0, base);
		}
		assert.equal((await fetchModelsDevInfoForBaseUrl("https://unknown-relay.example/v1")).size, 0);
		assert.equal((await fetchModelsDevInfoForBaseUrl("https://api.makerco.example/other/v1")).size, 0);
	});

	it("gives the host's own entry, prices included", async () => {
		const info = (await fetchModelsDevInfoForBaseUrl("https://a.example/v1")).get("makerco/flagship-1");
		assert.equal(info?.contextWindow, 200000, "what this host serves, not the maker's number");
		assert.deepEqual(info?.cost, { input: 9, output: 45, cacheRead: 0, cacheWrite: 0 });
	});

	it("recognizes native-API hosts the catalog lists without an endpoint", async () => {
		assert.ok((await fetchModelsDevInfoForBaseUrl("https://generativelanguage.googleapis.com/v1beta")).has("gemini-x"));
		assert.ok((await fetchModelsDevInfoForBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai")).has("gemini-x"));
	});

	it("falls back to the id index for models the host's entry does not cover", async () => {
		const info = await fetchModelsDevInfoForBaseUrl("https://api.makerco.example/v1", ["flagship-1", "openllama-70b", "nope"]);
		assert.deepEqual(info.get("flagship-1")?.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, "the host's own entry");
		assert.equal(info.get("openllama-70b")?.contextWindow, 32768, "from the id index");
		assert.equal(info.has("nope"), false);
	});

	it("still answers by id when the base URL is not a URL", async () => {
		assert.equal((await fetchModelsDevInfoForBaseUrl("not a url", ["flagship-1"])).get("flagship-1")?.contextWindow, 1000000);
	});
});

describe("lookup by model id (for gateways the catalog does not know)", () => {
	const lookup = async (id: string) => (await fetchModelsDevInfoByModelIds([id])).get(id);

	it("answers a proprietary model with what its maker published, not with what most resellers list", async () => {
		// Two resellers say 200K / 8K; the maker says 1M / 64K.
		assert.deepEqual(await lookup("flagship-1"), { contextWindow: 1000000, maxTokens: 64000, image: true, video: false, reasoning: true });
	});

	it("answers an open-weights model with what most hosts actually serve", async () => {
		// The lab entry is the architecture's maximum (131072); two of three hosts serve 32768 / 4096.
		const info = await lookup("openllama-70b");
		assert.equal(info?.contextWindow, 32768);
		assert.equal(info?.maxTokens, 4096);
	});

	it("falls back to the common value for ids the labs do not list", async () => {
		assert.deepEqual(await lookup("mystery-model"), { contextWindow: 8000, maxTokens: 1000, image: false, video: false, reasoning: false });
	});

	it("finds a model only its lab lists", async () => {
		assert.equal((await lookup("labonly-1"))?.contextWindow, 400000);
	});

	it("never takes prices from the id tier", async () => {
		assert.equal((await lookup("flagship-1"))?.cost, undefined);
		assert.equal((await lookup("makerco/flagship-1"))?.cost, undefined);
	});

	it("matches decorated ids", async () => {
		for (const id of ["relay/flagship-1", "FLAGSHIP-1", "flagship-1:free", "relay/flagship-1-20260101", "flagship-1@v2", "flagship-1[1m]", "aws/flagship-1-thinking"]) {
			assert.equal((await lookup(id))?.contextWindow, 1000000, id);
		}
	});

	it("has no answer for an unknown id, and none for names that exist on every object", async () => {
		for (const id of ["nope", "constructor", "__proto__", "toString", ""]) {
			assert.equal(await lookup(id), undefined, id);
		}
		assert.equal((await fetchModelsDevInfoByModelIds([])).size, 0);
	});
});

describe("parseSnapshotModule", () => {
	it("recovers the catalog and its date from the published module format", () => {
		const parsed = parseSnapshotModule(snapshotModule(CATALOG, "2026-08-24T05:34:22.988Z"));
		assert.deepEqual(Object.keys(parsed.providers).sort(), Object.keys(CATALOG.providers).sort());
		assert.equal(parsed.asOf, Date.parse("2026-08-24T05:34:22.988Z"));
		assert.ok("makerco/flagship-1" in parsed.models);
	});

	it("copes with quotes and backslashes inside the data", () => {
		const tricky = { providers: { p: { id: "p", name: 'He said "hi" \\ bye', models: {} } }, models: {} };
		assert.equal((parseSnapshotModule(snapshotModule(tricky)).providers as any).p.name, 'He said "hi" \\ bye');
	});

	it("rejects anything that is not a snapshot", () => {
		assert.throws(() => parseSnapshotModule("<html>503 Service Unavailable</html>"));
		assert.throws(() => parseSnapshotModule('const data = JSON.parse("{\\"providers\\":{}}")'), /no providers/);
		assert.throws(() => parseSnapshotModule('const data = JSON.parse("{not json")'));
		assert.throws(() => parseSnapshotModule(""));
	});
});
