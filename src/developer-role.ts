import { PROBE_TIMEOUT_MS } from "./types.ts";

// Probe whether a gateway accepts the OpenAI "developer" role in chat
// completions. Clients like pi send system messages as "developer" for
// reasoning models when the endpoint supports it; gateways that don't
// (Kimi's subscription endpoint, some One API forks, ...) answer
// 400 "role 'developer' is not allowed".
//
// Returns true (accepted), false (explicitly rejected), or undefined when
// the probe couldn't tell (network error, auth failure, an unrelated 4xx).
// Costs one tiny completion (max_tokens: 1) against the given model.
export async function probeDeveloperRole(
	baseUrl: string,
	apiKey: string | undefined,
	modelId: string,
): Promise<boolean | undefined> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"content-type": "application/json",
	};
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: "developer", content: "You are a helpful assistant." },
					{ role: "user", content: "Say ok." },
				],
				max_tokens: 1,
				stream: false,
			}),
			signal: controller.signal,
		});
	} catch {
		// Network error / timeout — inconclusive.
		return undefined;
	} finally {
		clearTimeout(timer);
	}

	if (response.ok) return true;
	// A 4xx that complains about the role is a definitive "no". Anything else
	// (auth, model not found, billing, ...) proves nothing about the role.
	if (response.status >= 400 && response.status < 500) {
		const body = await response.text().catch(() => "");
		if (/developer/i.test(body) || /role[^a-z]{0,20}(not|invalid|unsupported|unknown)/i.test(body)) return false;
	}
	return undefined;
}
