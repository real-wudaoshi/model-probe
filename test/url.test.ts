import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLocalHost, normalizeBaseUrl } from "../src/url.ts";

describe("normalizeBaseUrl", () => {
	it("keeps a well-formed base as it is, minus trailing slashes", () => {
		assert.equal(normalizeBaseUrl("https://api.example.com/v1"), "https://api.example.com/v1");
		assert.equal(normalizeBaseUrl("https://api.example.com/v1///"), "https://api.example.com/v1");
		assert.equal(normalizeBaseUrl("  http://localhost:4000  "), "http://localhost:4000");
	});

	it("adds http:// for local hosts and https:// for public ones", () => {
		assert.equal(normalizeBaseUrl("localhost:4000"), "http://localhost:4000");
		assert.equal(normalizeBaseUrl("127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
		assert.equal(normalizeBaseUrl("192.168.1.20:8000"), "http://192.168.1.20:8000");
		assert.equal(normalizeBaseUrl("ollama:11434"), "http://ollama:11434");
		assert.equal(normalizeBaseUrl("[::1]:8080/v1"), "http://[::1]:8080/v1");
		assert.equal(normalizeBaseUrl("api.example.com/v1"), "https://api.example.com/v1");
		assert.equal(normalizeBaseUrl("openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
	});

	it("drops a pasted endpoint path", () => {
		assert.equal(normalizeBaseUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1");
		assert.equal(normalizeBaseUrl("https://api.example.com/v1/completions"), "https://api.example.com/v1");
		assert.equal(normalizeBaseUrl("https://api.example.com/v1/responses"), "https://api.example.com/v1");
		assert.equal(normalizeBaseUrl("https://api.example.com/v1/models/"), "https://api.example.com/v1");
		assert.equal(normalizeBaseUrl("https://api.example.com/v1/messages"), "https://api.example.com/v1");
		assert.equal(normalizeBaseUrl("https://generativelanguage.googleapis.com/v1beta/models"), "https://generativelanguage.googleapis.com/v1beta");
	});

	it("drops the query string and fragment", () => {
		assert.equal(normalizeBaseUrl("https://api.example.com/v1?api-version=2024-10-21#x"), "https://api.example.com/v1");
	});

	it("rejects input that is not a URL, with a readable message", () => {
		assert.throws(() => normalizeBaseUrl(""), /empty/i);
		assert.throws(() => normalizeBaseUrl("   "), /empty/i);
		assert.throws(() => normalizeBaseUrl("ftp://example.com"), /http:\/\/ or https:\/\//);
		assert.throws(() => normalizeBaseUrl("http://"), /Not a valid base URL/);
	});
});

describe("isLocalHost", () => {
	it("recognizes loopback, private ranges and private names", () => {
		for (const host of [
			"localhost",
			"dev.localhost",
			"127.0.0.1",
			"127.8.9.1",
			"10.0.0.5",
			"192.168.1.1",
			"172.16.0.1",
			"172.31.255.1",
			"169.254.10.10",
			"100.64.0.7", // CGNAT / Tailscale
			"100.127.1.1",
			"0.0.0.0",
			"[::1]",
			"[fd12:3456:789a::1]",
			"[fe80::1]",
			"ollama", // docker compose service name
			"litellm",
			"host.docker.internal",
			"nas.local",
			"gateway.lan",
		]) {
			assert.equal(isLocalHost(host), true, host);
		}
	});

	it("does not mistake public hosts for local ones", () => {
		for (const host of [
			"api.openai.com",
			"example.com",
			"8.8.8.8",
			"172.32.0.1",
			"100.128.0.1",
			"192.169.1.1",
			"10.example.com", // a name, not an address
			"127.cloud.example.org",
			"[2001:db8::1]",
		]) {
			assert.equal(isLocalHost(host), false, host);
		}
	});
});
