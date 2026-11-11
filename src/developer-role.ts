import { authedRequest, parseJsonBody } from "./http.ts";
import type { HttpResult } from "./http.ts";

// Probe whether a gateway accepts the OpenAI "developer" role in chat
// completions. Clients like pi send system messages as "developer" for
// reasoning models when the endpoint supports it; gateways that don't
// (Kimi's subscription endpoint, some One API forks, ...) answer
// 400 "role 'developer' is not allowed".
//
// Returns true (accepted), false (explicitly rejected), or undefined when
// the probe couldn't tell (network error, auth failure, an unrelated error).
// Costs one tiny completion against the given model.

// How many models to try before giving up on a conclusive answer.
const MAX_CANDIDATES = 3;

// "next": this model couldn't tell (not a chat model, unknown id, ...) — another one might.
// "stop": the gateway itself is the obstacle (auth, quota, network) — no model will tell.
type Verdict = boolean | "next" | "stop";

// An error message hidden in a 2xx body: { error: ... } or { success: false }.
function errorEnvelope(json: any): string | undefined {
	if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
	if (json.error !== undefined && json.error !== null && json.error !== false) {
		return typeof json.error === "string" ? json.error : JSON.stringify(json.error);
	}
	if (json.success === false) return typeof json.message === "string" ? json.message : JSON.stringify(json);
	return undefined;
}

// Does this error text complain about the message ROLE? Merely containing
// the word "developer" is not enough: plenty of unrelated errors link to
// "developers.google.com" or a "developer guide".
function complainsAboutRole(text: string): boolean {
	const roleContext = /\broles?\b|messages?\s*[[.]\s*0/i.test(text);
	if (/\bdeveloper\b/i.test(text) && roleContext) return true;
	if (/\brole\b[^a-z]{0,20}(not|invalid|unsupported|unknown)/i.test(text)) return true;
	if (/\b(invalid|unsupported|unknown|unexpected|unrecognized|illegal)\s+(message\s+)?role\b/i.test(text)) return true;
	// The server lists the roles it does take: "expected one of system, user,
	// assistant", "Only user and assistant roles are supported".
	return roleContext && /\buser\b/i.test(text) && /\bassistant\b/i.test(text);
}

function classify(res: HttpResult): Verdict | "retry-limit-field" {
	const json = parseJsonBody(res.body)?.value;
	if (res.ok) {
		// A 200 that isn't a JSON object is a web page (wrong base URL), not an answer.
		if (!json || typeof json !== "object" || Array.isArray(json)) return "stop";
		const envelope = errorEnvelope(json);
		if (envelope !== undefined) return complainsAboutRole(envelope) ? false : "next";
		// Only an actual completion proves the role was accepted.
		return Array.isArray(json.choices) ? true : "next";
	}

	const text = res.body;
	if (res.status === 401 || res.status === 403 || res.status === 402 || res.status === 429) return "stop";
	// Validation errors, and the 5xx some servers produce when their chat
	// template chokes on a role.
	if (res.status === 400 || res.status === 422 || res.status >= 500) {
		if (complainsAboutRole(text)) return false;
		// Reasoning models take max_completion_tokens and refuse max_tokens.
		if (res.status === 400 && /max_tokens/i.test(text)) return "retry-limit-field";
	}
	return "next";
}

async function probeWithModel(baseUrl: string, apiKey: string | undefined, modelId: string): Promise<Verdict> {
	const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const limits: Array<Record<string, number>> = [{ max_tokens: 1 }, { max_completion_tokens: 16 }];
	for (const limit of limits) {
		let res: HttpResult;
		try {
			res = await authedRequest(url, apiKey, {
				method: "POST",
				headers: { accept: "application/json", "content-type": "application/json" },
				body: JSON.stringify({
					model: modelId,
					messages: [
						{ role: "developer", content: "You are a helpful assistant." },
						{ role: "user", content: "Say ok." },
					],
					...limit,
					stream: false,
				}),
			});
		} catch {
			return "stop"; // network error / timeout
		}
		const verdict = classify(res);
		if (verdict !== "retry-limit-field") return verdict;
	}
	return "next";
}

/**
 * @param modelId One model id, or several candidates: the probe moves on to
 *   the next one when a model cannot answer (not a chat model, unknown id).
 */
export async function probeDeveloperRole(
	baseUrl: string,
	apiKey: string | undefined,
	modelId: string | string[],
): Promise<boolean | undefined> {
	const candidates = (Array.isArray(modelId) ? modelId : [modelId])
		.filter((id) => typeof id === "string" && id.trim() !== "")
		.slice(0, MAX_CANDIDATES);
	for (const id of candidates) {
		const verdict = await probeWithModel(baseUrl, apiKey, id);
		if (typeof verdict === "boolean") return verdict;
		if (verdict === "stop") return undefined;
	}
	return undefined;
}

// Ids that are clearly not chat models: asking them about message roles only
// yields "this is not a chat model".
const NOT_A_CHAT_MODEL =
	/embed|rerank|whisper|tts|speech|transcri|moderation|dall-e|image|imagen|veo|sora|flux|diffusion|sdxl|midjourney|kling|babbage|davinci|audio|realtime|guard|ocr|bge-|clip|music|video|upscal/i;

/** Order model ids so the likeliest chat models come first (for the developer-role probe). */
export function chatModelCandidates(ids: string[]): string[] {
	const likely = ids.filter((id) => !NOT_A_CHAT_MODEL.test(id));
	const rest = ids.filter((id) => NOT_A_CHAT_MODEL.test(id));
	return [...likely, ...rest];
}
