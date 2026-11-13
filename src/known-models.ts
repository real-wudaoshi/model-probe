import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MetadataProvenance, ModelProbeInfo } from "./types.ts";
import { getMetadataProvenance, withMetadataProvenance } from "./provenance.ts";

// Known-model rules classify well-known model ids and preset their context
// window, image/video input, and reasoning support. Used when a gateway
// exposes no metadata (stock One API / New API, bare proxies, manually added
// models).
//
// Rules are DATA, loaded at runtime (rules.json shipped with the package),
// so users can extend them:
//   - a JSON file at ~/.model-probe-rules.json, or the path in the
//     MODEL_PROBE_RULES env var, is merged in (user rules win on conflicts)
//   - library users can call registerKnownModelRules()
//
// Entry order matters — more specific patterns (e.g. claude-sonnet-4-5) must
// come before their prefix (claude-sonnet-4). Precedence: programmatic rules,
// then the user file, then the built-in table.
export type KnownModelRule = {
	/** RegExp source, e.g. "^gpt-5". */
	pattern: string;
	/** RegExp flags, default "i". */
	flags?: string;
	contextWindow?: number;
	maxTokens?: number;
	image?: boolean;
	video?: boolean;
	reasoning?: boolean;
};

type CompiledRule = {
	pattern: string;
	regex: RegExp;
	contextWindow?: number;
	maxTokens?: number;
	image?: boolean;
	video?: boolean;
	reasoning?: boolean;
};

// rules.json sits at the package root: one level up from src/ when running
// the TypeScript sources, two levels up from dist/src/ in the published build.
function builtinRulesPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [join(here, "..", "rules.json"), join(here, "..", "..", "rules.json")];
	return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

const programmaticRules: KnownModelRule[] = [];
let cache: CompiledRule[] | null = null;

// Register extra rules from library code. They take precedence over both the
// user file and the built-in table.
export function registerKnownModelRules(rules: KnownModelRule[]): void {
	programmaticRules.push(...rules);
	cache = null;
}

// Drop the compiled cache so the next lookup re-reads the rule files.
export function reloadKnownModelRules(): void {
	cache = null;
}

// Say each problem once per process, not on every reload.
const warned = new Set<string>();
function warnOnce(message: string): void {
	if (warned.has(message)) return;
	warned.add(message);
	console.warn(`model-probe: ${message}`);
}

function positiveNumber(value: unknown): number | undefined {
	const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function compileRules(raw: unknown, source: string): CompiledRule[] {
	if (!Array.isArray(raw)) return [];
	const out: CompiledRule[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || typeof entry.pattern !== "string") continue;
		// "g" and "y" make RegExp.test() stateful (it resumes from lastIndex), so
		// a rule would match only every other lookup. Matching a whole id never
		// needs them.
		const flags = (typeof entry.flags === "string" ? entry.flags : "i").replace(/[gy]/g, "");
		try {
			out.push({
				pattern: entry.pattern,
				regex: new RegExp(entry.pattern, flags),
				contextWindow: positiveNumber(entry.contextWindow),
				maxTokens: positiveNumber(entry.maxTokens),
				image: typeof entry.image === "boolean" ? entry.image : undefined,
				video: typeof entry.video === "boolean" ? entry.video : undefined,
				reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : undefined,
			});
		} catch {
			warnOnce(`skipping invalid rule in ${source}: ${entry.pattern}`);
		}
	}
	return out;
}

// Editors and shells on Windows love to save JSON as UTF-8 with a BOM or as
// UTF-16 (PowerShell 5 redirection). JSON.parse rejects both, so decode first.
function decodeText(buffer: Buffer): string {
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
	if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		const body = Buffer.from(buffer.subarray(2, 2 + Math.floor((buffer.length - 2) / 2) * 2));
		body.swap16();
		return body.toString("utf16le");
	}
	const text = buffer.toString("utf8");
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readRulesFile(path: string): CompiledRule[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decodeText(readFileSync(path)));
	} catch (error) {
		warnOnce(`ignoring rules file ${path} — ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	if (!Array.isArray(parsed)) {
		warnOnce(`ignoring rules file ${path} — expected a JSON array of rules`);
		return [];
	}
	return compileRules(parsed, path);
}

function userRulesPath(): string {
	return process.env.MODEL_PROBE_RULES || join(homedir(), ".model-probe-rules.json");
}

function loadRules(): CompiledRule[] {
	if (cache) return cache;
	const rules = [...compileRules(programmaticRules, "registerKnownModelRules")];
	const userPath = userRulesPath();
	if (existsSync(userPath)) rules.push(...readRulesFile(userPath));
	rules.push(...readRulesFile(builtinRulesPath()));
	cache = rules;
	return rules;
}

// Decorations relays hang on the end of an id, tried in this order. Each rule
// removes one layer.
const SUFFIX_LAYERS: RegExp[] = [
	/\[[^[\]]*\]$/, // [1m]: relay convention marking a 1M-context variant
	/:[^/:]+$/, // :free / :thinking (OpenRouter), :latest / :8b (Ollama)
	/-(?:latest|recent|free|preview|stable|thinking|nothinking|reasoning|turbo|hi|highspeed|dev|beta|auto|labs|minimal|low|medium|high|xhigh|ascend)$/,
	/-20\d{6}$/, // date tail: -20250601
	/-\d{4}-\d{2}-\d{2}$/, // dashed date: -2025-08-07
	/-\d{2}-\d{2}$/, // month-day tail: -preview-05-20
	/-\d{2,9}$/, // serial / short date: -0731, -250324
];

function stripOneLayer(id: string): string | null {
	for (const layer of SUFFIX_LAYERS) {
		const next = id.replace(layer, "");
		if (next && next !== id) return next;
	}
	return null;
}

// Model id normalization candidates, most specific first. Relay gateways love
// decorating ids — bailian/deepseek-v4-pro, claude-x@20250601, gpt-5[1m],
// deepseek-v4-flash-free, deepseek/deepseek-r1:free — so lookups are tried
// against progressively stripped forms: lowercase → without @version → with
// each trailing decoration peeled off in turn (a date AND a variant word both
// come off) → and only lastly the same again without the path prefix (so an
// exact "vendor/model" entry still beats the bare id).
export function normalizeModelIdCandidates(modelId: string): string[] {
	const candidates: string[] = [];
	const push = (v: string) => {
		if (v && !candidates.includes(v)) candidates.push(v);
	};
	const pushPeeled = (start: string) => {
		push(start);
		let current = start;
		for (let depth = 0; depth < 8; depth++) {
			const next = stripOneLayer(current);
			if (!next) break;
			push(next);
			current = next;
		}
	};

	const raw = modelId.trim();
	push(raw);
	const lower = raw.toLowerCase();
	push(lower);
	// "model@version". An id that STARTS with "@" (Cloudflare's "@cf/meta/...")
	// has no version part to drop.
	const at = lower.indexOf("@");
	const withoutAt = at > 0 ? lower.slice(0, at) : lower;
	pushPeeled(withoutAt);

	// OpenAI fine-tunes: ft:<base model>:<org>:<suffix>:<id>.
	const fineTuneBase = /^ft:([^:]+):/.exec(withoutAt)?.[1];
	if (fineTuneBase) pushPeeled(fineTuneBase);

	const lastSegment = withoutAt.split("/").pop() ?? "";
	if (lastSegment && lastSegment !== withoutAt) pushPeeled(lastSegment);
	return candidates;
}

// A context window spelled out in the id itself: "claude-sonnet-4-6[1m]",
// "some-model[200k]". The marker names a variant with that window, so it says
// more about this id than a catalog entry for the base model does.
function declaredContextWindow(modelId: string): number | undefined {
	const match = /\[(\d+(?:\.\d+)?)\s*([km])\]\s*$/i.exec(modelId);
	if (!match) return undefined;
	const value = Number(match[1]) * (match[2].toLowerCase() === "m" ? 1_000_000 : 1_000);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

// Fill the context window from an explicit marker in the id, when the gateway
// itself reported none. Tagged as inferred — it is read off a naming
// convention, not reported by anyone.
export function applyModelIdHints(modelId: string, info: ModelProbeInfo | undefined): ModelProbeInfo | undefined {
	if (info?.contextWindow !== undefined) return info;
	const contextWindow = declaredContextWindow(modelId);
	if (contextWindow === undefined) return info;
	return withMetadataProvenance({
		...(info ?? {}),
		contextWindow,
		inferred: true,
		inferredFields: [...(info?.inferredFields ?? []), "contextWindow"],
	}, { ...getMetadataProvenance(info), contextWindow: { source: "id-hint", match: "hint", infer: true, candidate: modelId, ruleMatch: /\[[^\]]+\]\s*$/.exec(modelId)?.[0].trim() } });
}

// Classify a model id against the rules and return the preset metadata.
// Matching is per-field: the first matching rule that defines a field wins,
// later rules fill fields it didn't define — so a user rule that only sets
// contextWindow still inherits image/video/reasoning from the built-in table.
// Each normalization candidate runs the full rule list before the next, less
// specific candidate is tried.
function matchKnownModelRule(modelId: string): ModelProbeInfo | undefined {
	const info: ModelProbeInfo = {};
	const sources: MetadataProvenance = {};
	let matched = false;
	for (const candidate of normalizeModelIdCandidates(modelId)) {
		for (const rule of loadRules()) {
			const match = rule.regex.exec(candidate);
			if (!match) continue;
			matched = true;
			for (const field of ["contextWindow", "maxTokens", "image", "video", "reasoning"] as const) {
				if (info[field] !== undefined || rule[field] === undefined) continue;
				(info as Record<string, unknown>)[field] = rule[field];
				sources[field] = { source: "rule", match: "rule", infer: true, candidate, rulePattern: rule.pattern, ruleMatch: match[0] || undefined };
			}
		}
		if (
			info.contextWindow !== undefined &&
			info.maxTokens !== undefined &&
			info.image !== undefined &&
			info.video !== undefined &&
			info.reasoning !== undefined
		) {
			return withMetadataProvenance(info, sources);
		}
	}
	return matched ? withMetadataProvenance(info, sources) : undefined;
}

// Fill any fields the probe couldn't determine from the known-model rules.
// Real detected values always win; the rules only fill gaps. inferredFields
// records exactly which fields came from the rules.
export function applyKnownModelFallback(modelId: string, info: ModelProbeInfo | undefined): ModelProbeInfo | undefined {
	const known = matchKnownModelRule(modelId);
	if (!known) return info;
	const filled: ModelProbeInfo = {};
	const inferredFields: Array<"contextWindow" | "maxTokens" | "image" | "video" | "reasoning"> = [...(info?.inferredFields ?? [])];
	const before = inferredFields.length;
	if (info?.contextWindow === undefined && known.contextWindow !== undefined) {
		filled.contextWindow = known.contextWindow;
		inferredFields.push("contextWindow");
	}
	if (info?.maxTokens === undefined && known.maxTokens !== undefined) {
		filled.maxTokens = known.maxTokens;
		inferredFields.push("maxTokens");
	}
	if (info?.image === undefined && known.image !== undefined) {
		filled.image = known.image;
		inferredFields.push("image");
	}
	if (info?.video === undefined && known.video !== undefined) {
		filled.video = known.video;
		inferredFields.push("video");
	}
	if (info?.reasoning === undefined && known.reasoning !== undefined) {
		filled.reasoning = known.reasoning;
		inferredFields.push("reasoning");
	}
	if (inferredFields.length === before) return info;
	const sources = getMetadataProvenance(info), guessed = getMetadataProvenance(known);
	for (const field of Object.keys(filled) as Array<keyof typeof sources>) sources[field] = guessed[field];
	return withMetadataProvenance({ ...(info ?? {}), ...filled, inferred: true, inferredFields }, sources);
}
