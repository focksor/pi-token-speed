/**
 * Functional smoke test for the global (cross-session) speed display.
 * Simulates one main TUI session + three subagent sessions in a single process,
 * the way pi-subagents creates them: child sessions share the process but get
 * a no-op UI (hasUI: false), and each session loads its own extension instance.
 *
 * Regression focus:
 *  - the label follows the EXECUTING count (stable while agents stream in turns),
 *    never the momentary streaming count (no name/count flapping)
 *  - a registered agent that is not streaming never renders as "—" and never
 *    makes the whole segment disappear
 *
 * Run: node test-global.ts
 */
import extensionFactory from "./token-speed.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Regression: /reload keeps globalThis alive across extension reloads, so a
// store written by an OLDER build (different schema — here: the former
// samples-based shape) is what the new build may find. It must be migrated,
// not trusted — this exact shape used to crash touch() with
// "Cannot read properties of undefined (reading 'get')".
globalThis[Symbol.for("pi-token-speed.shared-store")] = {
	samples: new Map(),
	renderers: new Set(),
	flushScheduled: false,
};

function createInstance({ name, hasUI }) {
	const handlers = new Map();
	const statuses = [];
	const pi = {
		on: (type, handler) => {
			if (!handlers.has(type)) handlers.set(type, []);
			handlers.get(type).push(handler);
		},
	};
	if (name !== undefined) pi.getSessionName = () => name;

	extensionFactory(pi);

	const ctx = {
		hasUI,
		ui: {
			setStatus: (key, value) => {
				statuses.push({ key, value });
			},
		},
	};

	const fire = async (type, event = {}) => {
		for (const handler of handlers.get(type) ?? []) {
			await handler(event, ctx);
		}
	};

	return {
		fire,
		statuses,
		last: () => statuses.at(-1)?.value,
		statusCount: () => statuses.length,
	};
}

const assistantMessage = (text) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	usage: { output: 0 }, // force the chars/4 estimate path while streaming
});

let failures = 0;
const expect = (main, condition, message) => {
	if (condition) {
		console.log(`ok: ${message}`);
	} else {
		failures++;
		console.error(`FAIL: ${message}`);
		console.error("  last status:", JSON.stringify(main.last()));
	}
};

/**
 * Stream `steps` deltas `stepMs` apart, growing the text steadily, so the
 * bucketed-median estimator has enough samples to report a rate. Returns the
 * final character count.
 */
async function streamDeltas(inst, { steps, stepMs = 100, charsPerStep = 40, from = 0 }) {
	let chars = from;
	for (let i = 0; i < steps; i++) {
		chars += charsPerStep;
		await sleep(stepMs);
		await inst.fire("message_update", { message: assistantMessage("x".repeat(chars)) });
	}
	return chars;
}

// --- one main TUI session + three subagent sessions, one process ------------
const main = createInstance({ name: undefined, hasUI: true });
const subA = createInstance({ name: "gp-alpha#aaaa1111", hasUI: false });
const subB = createInstance({ name: "gp-beta#bbbb2222", hasUI: false });
const subC = createInstance({ name: "gp-gamma#cccc3333", hasUI: false });

const all = [main, subA, subB, subC];
for (const inst of all) await inst.fire("session_start", { reason: "startup" });

// [issue 2] three agents executing, none streaming yet: segment must show the
// bare count — not vanish, and not render a "—" placeholder.
expect(main, main.last() === "⚡ 3 sub", `registered-but-idle shows "⚡ 3 sub" ("${main.last()}")`);

// [issue 1] one of three streams: the label must stay "3 sub", not flip to a name.
await subA.fire("message_start", { message: assistantMessage("") });
expect(
	main,
	main.last() === "⚡ 3 sub",
	`streamer in TTFT phase keeps "⚡ 3 sub" without a "—" ("${main.last()}")`,
);
// The estimator is a bucketed median: it reports nothing until it has at least
// two buckets of history, so feed it a realistic short stream.
await streamDeltas(subA, { steps: 6, charsPerStep: 40 });
await sleep(10);
expect(
	main,
	/⚡ 3 sub · [\d.]+ tok\/s/.test(main.last()),
	`one streamer of three still labelled "3 sub" with a real speed ("${main.last()}")`,
);
expect(main, !main.last()?.includes("gp-"), "no agent name while several agents are executing");

// streamer finishes its message (turn gap): the aggregate must fall back to
// that agent's LAST measured speed — like the main segment's persisted final
// speed — never to a bare count (within AGGREGATE_SPEED_TTL_MS of the sample).
await subA.fire("message_end", { message: assistantMessage("x".repeat(240)) });
await sleep(10);
expect(
	main,
	/⚡ 3 sub · [\d.]+ tok\/s/.test(main.last()),
	`turn gap shows the last measured aggregate speed ("${main.last()}")`,
);

// a second agent streams; label still count-based, speed is the current sum.
await subB.fire("message_start", { message: assistantMessage("") });
await streamDeltas(subB, { steps: 6, charsPerStep: 120 });
await sleep(10);
expect(main, /⚡ 3 sub · [\d.]+ tok\/s/.test(main.last()), `two streamers aggregate ("${main.last()}")`);

// main streams too: both segments combine. The TTFT wait shows a LIVE timer:
// it starts at before_provider_request (the same anchor the final TTFT is
// measured from) and ticks with no pi events in between.
await main.fire("before_provider_request");
expect(
	main,
	/^⚡ \.\.\. tok\/s · TTFT \S+… · 3 sub/.test(main.last() ?? ""),
	`wait timer starts at before_provider_request ("${main.last()}")`,
);
const ticksBefore = main.statusCount();
await sleep(350);
const ticksAfter = main.statusCount();
expect(
	main,
	ticksAfter - ticksBefore >= 2 && /^⚡ \.\.\. tok\/s · TTFT \S+… · 3 sub/.test(main.last() ?? ""),
	`TTFT wait timer ticks with no events (${ticksAfter - ticksBefore} renders in 350ms, "${main.last()}")`,
);
await main.fire("message_start", { message: assistantMessage("") });
expect(
	main,
	/^⚡ \.\.\. tok\/s · TTFT \S+… · 3 sub/.test(main.last() ?? ""),
	`main wait timer + sub segment ("${main.last()}")`,
);

// Regression (throttle starvation): a sub flush render lands right before a
// main delta — after the estimator has been seeded, the main segment must show
// real values, never the "..." placeholder.
await streamDeltas(subB, { steps: 3, charsPerStep: 120, from: 720 });
await main.fire("message_update", { message: assistantMessage("m".repeat(50)) });
expect(
	main,
	/⚡ [\d.]+ tok\/s · TTFT \S+ · 3 sub/.test(main.last()),
	`main delta renders despite concurrent sub flush ("${main.last()}")`,
);
// The live timer must stop at the first token: while idle, no further renders.
const idleBefore = main.statusCount();
await sleep(350);
expect(main, main.statusCount() === idleBefore, "TTFT timer stops after the first token");
await streamDeltas(main, { steps: 3, stepMs: 150, charsPerStep: 300, from: 940 });
await sleep(10);
expect(
	main,
	/ [\d.]+ tok\/s · TTFT \S+ · 3 sub · [\d.]+ tok\/s/.test(main.last()),
	`main + sub aggregate combined ("${main.last()}")`,
);
await main.fire("message_end", { message: assistantMessage("m".repeat(200)) });
await sleep(150);

// [persist-shown-speed] main has shown a real speed once, so a NEW request's
// wait and warmup phases must keep it on screen instead of reverting to "..."
// (only a session that has never shown a speed displays the placeholder).
await main.fire("before_provider_request");
await sleep(10);
expect(
	main,
	/^⚡ [\d.]+ tok\/s · TTFT \S+… · 3 sub/.test(main.last() ?? ""),
	`second wait keeps the last shown speed, no "..." ("${main.last()}")`,
);
await main.fire("message_start", { message: assistantMessage("") });
await sleep(10);
expect(
	main,
	/^⚡ [\d.]+ tok\/s · TTFT \S+… · 3 sub/.test(main.last() ?? ""),
	`pre-first-token still shows the last speed with a live TTFT ("${main.last()}")`,
);
// [estimator] the streaming speed is a bucketed median, so it needs a couple of
// samples before it reports anything; until then the previous response's speed
// stays on screen (never "..." once a speed has been shown).
await main.fire("message_update", { message: assistantMessage("m".repeat(40)) });
expect(
	main,
	/^⚡ [\d.]+ tok\/s · TTFT \S+ · 3 sub/.test(main.last() ?? "") && !main.last()?.includes("…"),
	`first delta keeps the previous speed until the estimator has history ("${main.last()}")`,
);
// Three deltas ~150ms apart at a steady rate: the estimate must land on the true
// rate, not on a value inflated by the first (batched) chunk. 940 chars = 235
// tokens over ~450ms = ~500 tok/s.
await streamDeltas(main, { steps: 3, stepMs: 150, charsPerStep: 300, from: 40 });
await sleep(10);
const steadyShown = Number(/^⚡ ([\d.]+) tok\/s/.exec(main.last() ?? "")?.[1]);
expect(
	main,
	steadyShown >= 450 &&
		steadyShown <= 550 &&
		!main.last()?.includes("tok/s · 5000"),
	`bucketed median reports the true steady rate, not the chunk spike (${steadyShown} tok/s, "${main.last()}")`,
);
await main.fire("message_end", { message: assistantMessage("m".repeat(940)) });
await sleep(150);

// [issue 1] agents finish one by one: the executing count shrinks stepwise.
await subA.fire("agent_end", {});
await sleep(10);
expect(main, main.last()?.includes("2 sub"), `agent_end drops the count to "2 sub" ("${main.last()}")`);
expect(
	main,
	/⚡ [\d.]+ tok\/s · TTFT \S+ · 2 sub/.test(main.last()),
	"main speed stays visible alongside the aggregate after it has streamed once",
);

await subB.fire("agent_end", {});
await sleep(10);
expect(
	main,
	main.last()?.includes("sub gp-gamma") && main.last()?.includes("TTFT"),
	`single remaining agent shows its name, main speed still first ("${main.last()}")`,
);

await subC.fire("message_start", { message: assistantMessage("") });
await streamDeltas(subC, { steps: 6, charsPerStep: 100 });
await sleep(10);
expect(
	main,
	/⚡ [\d.]+ tok\/s · TTFT \S+ · sub gp-gamma · [\d.]+ tok\/s/.test(main.last()),
	`main speed + single agent name + speed ("${main.last()}")`,
);

await subC.fire("agent_end", {});
await sleep(150);
expect(
	main,
	!main.last()?.includes("sub") && /⚡ [\d.]+ tok\/s · TTFT \S+/.test(main.last()),
	`all done: aggregate gone, main final speed persists ("${main.last()}")`,
);

// abort/error path: a request that never produces a message (agent ends while
// waiting) must fall back to the persisted final speed — no frozen wait timer,
// no further ticking.
await main.fire("before_provider_request");
await sleep(50);
await main.fire("agent_end", {});
await sleep(10);
const afterAbort = main.last() ?? "";
expect(
	main,
	/⚡ [\d.]+ tok\/s · TTFT \S+$/.test(afterAbort) && !afterAbort.includes("…"),
	`aborted wait falls back to the final speed ("${afterAbort}")`,
);
const abortIdleBefore = main.statusCount();
await sleep(350);
expect(main, main.statusCount() === abortIdleBefore, "no ticking after an aborted wait");

// ─ spike regressions (the reason the estimator was replaced) ───────────────
// A response whose FIRST delta already carries a large batch must not report the
// batch as a rate. 4000 chars = 1000 tokens delivered at 150ms, then a 40 tok/s
// trickle: the pre-fix code showed ~6600 tok/s and kept showing it.
{
	const spikes = createInstance({ name: undefined, hasUI: true });
	await spikes.fire("session_start", {});
	await spikes.fire("before_provider_request");
	await spikes.fire("message_start", { message: assistantMessage("") });
	await sleep(150);
	await spikes.fire("message_update", { message: assistantMessage("b".repeat(4000)) });
	// The very first delta is deliberately below the 3-sample estimator floor:
	// no rate is claimed at all (the "..." placeholder is correct here).
	expect(
		main,
		/^⚡ \.\.\. tok\/s/.test(spikes.last() ?? ""),
		`a single batched delta claims no rate (${spikes.last()})`,
	);
	// Later, steady deltas re-establish the real rate and must not inherit it.
	for (let i = 1; i <= 6; i++) {
		await sleep(100);
		await spikes.fire("message_update", {
			message: assistantMessage("b".repeat(4000 + i * 16)),
		});
	}
	const finalSpeed = Number(/^⚡ ([\d.]+) tok\/s/.exec(spikes.last() ?? "")?.[1]);
	expect(
		main,
		Number.isFinite(finalSpeed) && finalSpeed < 120,
		`steady trickle after a fat first chunk stays near the true 40 tok/s (${spikes.last()})`,
	);
	await sleep(4000); // past AGGREGATE_SPEED_TTL_MS
	const ttlBefore = spikes.statusCount();
	await sleep(200);
	expect(
		main,
		spikes.statusCount() === ttlBefore,
		"an idle finished session stops contributing to the aggregate",
	);
	await spikes.fire("session_shutdown", {});
}

// A mid-stream batch (a whole tool-call argument blob) must not lift the rate.
{
	const spikes = createInstance({ name: undefined, hasUI: true });
	await spikes.fire("session_start", {});
	await spikes.fire("before_provider_request");
	await spikes.fire("message_start", { message: assistantMessage("") });
	for (let i = 1; i <= 6; i++) {
		await sleep(100);
		const chars = i * 40 + (i === 4 ? 8000 : 0); // 2000-token blob at i=4
		await spikes.fire("message_update", { message: assistantMessage("b".repeat(chars)) });
	}
	const midSpeed = Number(/^⚡ ([\d.]+) tok\/s/.exec(spikes.last() ?? "")?.[1]);
	expect(
		main,
		Number.isFinite(midSpeed) && midSpeed < 120,
		`a mid-stream argument blob does not lift the rate (${spikes.last()})`,
	);
	await spikes.fire("session_shutdown", {});
}

// session disposal must not disturb the main footer.
const before = main.statusCount();
await subA.fire("session_shutdown", {});
await subB.fire("session_shutdown", {});
await subC.fire("session_shutdown", {});
await sleep(150);
expect(main, main.statusCount() === before, "disposed subagent sessions trigger no further renders");

// subagent instances must never have touched their (no-op) UIs.
for (const [inst, label] of [
	[subA, "gp-alpha"],
	[subB, "gp-beta"],
	[subC, "gp-gamma"],
]) {
	expect(main, inst.statusCount() === 0, `${label} instance never calls setStatus`);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed.`);
	process.exit(1);
}
console.log("\nAll checks passed.");
