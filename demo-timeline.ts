/**
 * Visual demo of the footer timeline across two consecutive responses,
 * driven with realistic streaming (TTFT wait, ~100ms chunks, occasional
 * bursts) through the REAL extension code.
 *
 * Watch for:
 *   response 1: TTFT wait timer → TTFT freezes → bucketed-median speed settles
 *   response 2: the previous response's speed is kept through the wait
 *
 * Run: node demo-timeline.ts
 */
import extensionFactory from "./token-speed.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const t0 = performance.now();
const stamp = () => `[+${((performance.now() - t0) / 1000).toFixed(2).padStart(6)}s] `;

function createInstance() {
	const handlers = new Map();
	const pi = {
		on: (type, handler) => {
			if (!handlers.has(type)) handlers.set(type, []);
			handlers.get(type).push(handler);
		},
	};
	extensionFactory(pi);
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (_key, value) => {
				if (value !== undefined) console.log(stamp() + value);
			},
		},
	};
	return {
		fire: async (type, event = {}) => {
			for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
		},
	};
}

/** Cumulative assistant message; chars/4 estimate reproduces `tokens` exactly. */
const msg = (tokens) => ({
	role: "assistant",
	content: [{ type: "text", text: "x".repeat(tokens * 4) }],
	usage: { output: 0 },
});

/** Stream one response: `ttft` ms of waiting, then varied chunks every ~100ms. */
async function stream(inst, { ttft, ms, label }) {
	console.log(`\n── ${label} · request sent, TTFT ≈ ${ttft}ms ──`);
	await inst.fire("before_provider_request");
	await sleep(ttft);
	await inst.fire("message_start", { message: msg(0) });
	let tokens = 0;
	for (let i = 0; i < Math.floor(ms / 100); i++) {
		// deterministic varied chunks: 2-10 tokens per ~100ms, one burst at i=3
		tokens += 2 + ((i * 7) % 9) + (i === 3 ? 8 : 0);
		await inst.fire("message_update", { message: msg(tokens) });
		await sleep(100);
	}
	await inst.fire("message_end", { message: msg(tokens) });
}

const inst = createInstance();
await inst.fire("session_start", {});

await stream(inst, { ttft: 700, ms: 2200, label: "Response 1 (first ever)" });

console.log(`\n── idle 1.5s ──`);
await sleep(1500);

await stream(inst, {
	ttft: 900,
	ms: 2200,
	label: "Response 2 (previous speed is kept through the wait)",
});

await sleep(300);
console.log("\n(end)");
