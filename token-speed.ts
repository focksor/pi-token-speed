import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-speed";
const LIVE_REFRESH_INTERVAL_MS = 100;
/** Safety net: drop sessions whose instance stopped reporting without a clean end (crash/kill). */
const SESSION_TTL_MS = 5 * 60_000;
/** Width cap for a single subagent label in the footer. */
const MAX_LABEL_WIDTH = 16;
/**
 * Speed estimator window: how many recent CYCLES back the live estimate looks.
 * A cycle is measured between two token-carrying arrivals, so a fat delta can
 * only ever pollute its own cycle instead of a wall-clock bucket that mixes a
 * stall with several bursts.
 *
 * Sized for SMOOTHNESS, not just glitch rejection: with an 8-cycle window the
 * display of an honestly jittery stream (3-8 tokens per 45-80ms cycle, true 87
 * tok/s) swung over a 57 tok/s range and drifted up to 37% off the true rate
 * (measured, virtual clock). At 16 cycles the same stream swings over 38 and
 * drifts at most 25%, a third less wobble, while a genuine step still lands in
 * 400ms of displayed history (200ms at 8).
 *
 * Why not wider: past ~16 cycles the extra smoothing buys nothing for glitch
 * rejection and only costs responsiveness (24 cycles -> 600ms, 32 -> 800ms).
 * Why not the 5s time-window that oh-my-tps/opencode-tps use: a window that
 * averages tokens-over-time is a MEAN, so it loses the outlier rejection a
 * median provides — measured, it silently drops both the 4/8-pollution and
 * thinking-burst cases this estimator must survive, and shows nothing at all
 * for responses shorter than its 2s floor.
 */
const SPEED_WINDOW = 16;
/**
 * Below this many cycles the window takes the MINIMUM instead of the median.
 * A median only discards outliers while they stay a minority; with a 3-cycle
 * window two polluted cycles already carry it (measured: 2600 tok/s against a
 * true 100). The minimum is the only honest reading when data is scarce.
 *
 * Set to 7 rather than 5 because a 5-6 cycle window is still a minority-margin
 * window: 3 polluted cycles in an early 8-cycle window carried the median to
 * 10100 (measured), and only the min rule suppresses that. The wider rule is
 * deliberately conservative — it can read LOW while the window fills, never
 * HIGH. Cost is bounded to the first 6 cycles of a response; steady state is
 * unaffected (a 12-cycle 50/200 jitter stream still reads the true 125).
 */
const SPEED_SMALL_WINDOW = 7;
/** Fewest cycles that can produce a rate at all (2 intervals = 3 arrivals). */
const SPEED_MIN_CYCLES = 2;
/**
 * Sample buffer bound. Indices only — there is deliberately NO time-based
 * cutoff. The former 1800ms cutoff left only 3 arrivals for a provider
 * emitting a delta every 700ms+, i.e. exactly SPEED_MIN_CYCLES, so the
 * estimator degraded to the min rule and a single stretched cycle dominated
 * the reading (measured: one 50 tok/s cycle read as 50 instead of 100).
 * Count-only clipping keeps the full SPEED_WINDOW for any arrival spacing.
 */
const SPEED_MAX_SAMPLES = 512;
/**
 * Plausibility gate: a speed outside the model's own observed distribution is
 * far more likely to be an arrival artifact than a real rate. The bound is
 * DERIVED FROM HISTORY — never a hardcoded maximum — so a genuinely fast model
 * is not capped by a constant chosen for a slow one.
 */
const HISTORY_CAP = 32;
/**
 * Samples needed before the gate activates. A response contributing at least
 * HISTORY_MIN_CYCLES cycles writes HISTORY_SEGMENTS samples, so activation is
 * 3 responses at any delivery granularity — measured: 4, 6, 8, 16 and 24
 * cycles per response all activate on the 3rd response, and a 3-cycle response
 * contributes nothing.
 */
const HISTORY_MIN_SAMPLES = 12;
/**
 * Robust samples recorded per response: the response's cycles are split into
 * this many segments and each segment's median is stored, so a single spike
 * cannot move the history while the ring still fills fast enough that the gate
 * activates after a few responses (one sample per response would take
 * HISTORY_MIN_SAMPLES responses).
 *
 * A response with fewer cycles than segments splits into one-cycle segments.
 * That is correct, not a shortcut: robustness here comes from the median over
 * the whole ring (many samples per key), not from within-segment medians, and
 * a one-cycle segment faithfully preserves the sampled distribution. Forced
 * pairing is actively harmful — with 4 cycles and 1 spike, 2-cycle segments
 * put a spike and an honest cycle in the same pair, manufacturing a polluted
 * sample whose median lies between them (measured: a 1-in-4 spike trained the
 * gate bound 280 -> 24839, i.e. the gate stopped gating).
 *
 * For long responses (>= 8 cycles here) segments are long enough that their
 * medians do discard spikes, which is where that protection actually applies.
 */
const HISTORY_SEGMENTS = 4;
/**
 * Fewest cycles that make a response evidence at all.
 *
 * Counting CYCLES rather than chunks is what a delivery-granularity-agnostic
 * rule requires. The former value (HISTORY_SEGMENTS * 2 = 8) silently assumed
 * fine-grained delivery: a provider emitting one delta every 700ms+ produces
 * only ~3 cycles in a long response, so its history stayed empty FOREVER and
 * the gate never activated (measured: 12 trained responses then 3/6 pollution
 * still peaked at 10100 against a true 100). Such a provider is exactly the
 * coarse gateway batching this extension must survive.
 *
 * Kept at 4 — one cycle per segment, since HISTORY_SEGMENTS is 4 — because a
 * short response must stay splittable into HISTORY_SEGMENTS non-empty parts.
 * Do NOT raise segments above the cycle count: an EMPTY segment's median is
 * undefined and is silently skipped, which would quietly under-sample.
 */
const HISTORY_MIN_CYCLES = 4;
/**
 * Robust sigmas above the median before a rate is treated as an artifact.
 * Together with GATE_SPREAD_FLOOR this lands at roughly 2.8x the median for a
 * typical history, i.e. wide enough that honest variation is never cut.
 */
const GATE_K = 6;
/** MAD -> sigma consistency factor for a normal distribution. */
const MAD_TO_SIGMA = 1.4826;
/**
 * Spread floor as a fraction of the median, so an unusually tight history
 * cannot set a razor-thin gate that rejects honest jitter.
 */
const GATE_SPREAD_FLOOR = 0.3;

/** One (provider, model)'s observed cycle rates, as a fixed-size ring. */
interface SpeedHistory {
	samples: number[];
	/** Write cursor once `samples` is full. */
	next: number;
}

/** A derived plausibility bound: rates above it are arrival artifacts. */
interface Gate {
	median: number;
	bound: number;
}

/**
 * How long a session's last measured speed keeps counting toward the subagent
 * aggregate after it stops streaming. Without this an agent parked in a long
 * tool phase keeps adding its frozen rate to the sum forever, so a finished
 * burst inflates the aggregate indefinitely.
 */
const AGGREGATE_SPEED_TTL_MS = 3000;

/**
 * One streaming sample: the cumulative estimated output tokens at a wall-clock
 * instant, both relative to the start of the assistant response.
 */
interface SpeedSample {
	at: number;
	tokens: number;
}

interface SpeedState {
	startedAt: number;
	requestSentAt?: number;
	firstTokenAt?: number;
	samples: SpeedSample[];
}

interface LiveSpeed {
	tokens: number;
	/** Undefined until the estimator has enough history (see estimateStreamSpeed). */
	speed?: number;
	ttft?: number;
}

/**
 * Lifecycle record one extension instance keeps about its own session.
 *
 * `running` spans the whole agent execution (session_start → agent_end), including
 * tool phases and thinking gaps where nothing streams. `speed` is present only
 * while the session is actively streaming a response. Keeping the two apart is
 * what keeps the footer label stable: the label follows the executing count,
 * the speed follows whoever currently streams.
 */
interface SessionEntry {
	label?: string;
	running: boolean;
	speed?: number;
	/** Last measured (post-estimator) speed for this session — shown when it is
	 *  not currently streaming, mirroring the main session's persist-last-final
	 *  behavior. Cleared implicitly when the entry is removed (agent end). */
	lastSpeed?: number;
	/** When `lastSpeed` was measured; it stops counting toward the aggregate once
	 *  it is older than AGGREGATE_SPEED_TTL_MS. */
	speedAt?: number;
	updatedAt: number;
}

// -------------------------------------------------------------------------------------------
// Cross-session store — the "global" part of the global speed display.
//
// pi-subagents runs every subagent as an in-process AgentSession with its own freshly
// loaded set of extension instances, and child sessions get pi's no-op UI context, so a
// subagent instance's ctx.ui.setStatus goes nowhere. For a subagent's live speed to reach
// the main footer at all, every instance (main + every subagent) reports into one
// process-wide store — globalThis survives the per-session module re-evaluation — while
// the single instance whose session owns a real UI renders the aggregate of all sessions
// except its own.
// -------------------------------------------------------------------------------------------

interface SharedStore {
	sessions: Map<string, SessionEntry>;
	/** Per (provider, model) observed cycle rates — the plausibility gate's input. */
	history: Map<string, SpeedHistory>;
	renderers: Set<() => void>;
	flushScheduled: boolean;
}

const STORE_KEY = Symbol.for("pi-token-speed.shared-store");

function getStore(): SharedStore {
	// The store lives on globalThis and survives /reload — where it may have been
	// written by an older build of this extension with a different schema. Never
	// trust the cached object's shape: migrate field-wise, defaulting what's
	// missing, so a schema change can never crash the new build.
	const holder = globalThis as { [STORE_KEY]?: unknown };
	const previous = holder[STORE_KEY] as Partial<SharedStore> | undefined;
	const store: SharedStore = {
		sessions: previous?.sessions instanceof Map ? previous.sessions : new Map(),
		history: previous?.history instanceof Map ? previous.history : new Map(),
		renderers: previous?.renderers instanceof Set ? previous.renderers : new Set(),
		flushScheduled: false,
	};
	holder[STORE_KEY] = store;
	return store;
}

/** Fan out to every renderer (microtask-deferred, coalesced, failure-isolated). */
function scheduleFlush(store: SharedStore): void {
	if (store.flushScheduled) return;
	store.flushScheduled = true;
	queueMicrotask(() => {
		store.flushScheduled = false;
		for (const render of [...store.renderers]) {
			try {
				render();
			} catch {
				// one broken renderer must not break the others
			}
		}
	});
}

function pruneStaleSessions(store: SharedStore, now: number): void {
	for (const [id, entry] of store.sessions) {
		if (now - entry.updatedAt > SESSION_TTL_MS) {
			store.sessions.delete(id);
		}
	}
}

function asAssistantMessage(message: unknown): AssistantMessage | undefined {
	if (!message || typeof message !== "object" || !("role" in message)) {
		return undefined;
	}

	return (message as { role?: unknown }).role === "assistant"
		? (message as AssistantMessage)
		: undefined;
}

function estimateOutputTokens(message: AssistantMessage): number {
	let characters = 0;

	for (const part of message.content) {
		switch (part.type) {
			case "text":
				characters += part.text.length;
				break;
			case "thinking":
				characters += part.thinking.length;
				break;
			case "toolCall":
				characters += part.name.length;
				characters += JSON.stringify(part.arguments)?.length ?? 0;
				break;
		}
	}

	return Math.ceil(characters / 4);
}

function getOutputTokens(message: AssistantMessage): number {
	const reportedTokens = message.usage.output;
	if (Number.isFinite(reportedTokens) && reportedTokens > 0) {
		return reportedTokens;
	}

	return estimateOutputTokens(message);
}

function tokensPerSecond(tokens: number, startedAt: number): number {
	const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
	return tokens / elapsedSeconds;
}

/**
 * Median weighted by each cycle's DURATION.
 *
 * A count-based median weights a 1ms cycle the same as a 50ms one, so a burst
 * of back-to-back deltas — the first-token flush after a long TTFT, or a proxy
 * releasing its buffer — can occupy half the window while representing only a
 * few milliseconds of actual generation. Measured on a real footer: 5 deltas
 * 1ms apart drove the display to 49764 tok/s against a true ~100, and the
 * damage was not limited to 1ms gaps (2ms gaps still read 12550, 5ms read
 * 5050) because the burst's *rate* is what is enormous, not only its brevity.
 *
 * Weighting by span makes the window reflect real elapsed time: the same burst
 * becomes a negligible fraction of the total weight, so it cannot reach the
 * middle of the distribution. This preserves the outlier rejection a median
 * gives while removing the count-based blind spot.
 */
function weightedMedian(cycles: Array<{ rate: number; span: number }>): number | undefined {
	const usable = cycles.filter((cycle) => cycle.span > 0 && Number.isFinite(cycle.rate));
	if (usable.length === 0) return undefined;
	const sorted = [...usable].sort((a, b) => a.rate - b.rate);
	const total = sorted.reduce((sum, cycle) => sum + cycle.span, 0);
	if (!(total > 0)) return undefined;
	// At the 50% crossing, return the midpoint of the two straddling rates.
	// With equal spans this reduces EXACTLY to the plain median (including its
	// average-of-two-middle-values behavior), so existing, well-understood
	// behavior is preserved; unequal spans are what the weighting is for.
	let accumulated = 0;
	for (let i = 0; i < sorted.length; i++) {
		const before = accumulated;
		accumulated += sorted[i].span;
		if (accumulated > total / 2) {
			if (before < total / 2) return sorted[i].rate;
			// Landed exactly on the boundary: average with the previous rate.
			const previous = sorted[i - 1];
			return previous ? (previous.rate + sorted[i].rate) / 2 : sorted[i].rate;
		}
	}
	return sorted[sorted.length - 1]?.rate;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Per-cycle rates: the rate of each interval between two token-carrying
 * arrivals, most recent `keep` cycles first-to-last.
 *
 * A zero-token arrival cannot open a cycle, so role-only, finish_reason,
 * usage-only and heartbeat events cannot pollute the estimate at all — the
 * former bucketing had to absorb them, which either flickered to 0 or (if
 * dropped) inflated by the reciprocal of the content ratio.
 */
function cycleRates(samples: SpeedSample[], keep: number): Array<{ rate: number; span: number }> {
	// Indices of arrivals that carry tokens (the first sample counts only if
	// it already does — the initial message_start sample never does).
	const content: number[] = [];
	for (let i = 0; i < samples.length; i++) {
		const grew =
			i === 0 ? samples[i].tokens > 0 : samples[i].tokens > samples[i - 1].tokens;
		if (grew) content.push(i);
	}

	const rates: Array<{ rate: number; span: number }> = [];
	const from = Math.max(1, content.length - keep);
	for (let k = from; k < content.length; k++) {
		const prev = samples[content[k - 1]];
		const cur = samples[content[k]];
		const span = cur.at - prev.at;
		if (span <= 0) continue;
		// Clamp: a message rewritten mid-stream can lower the partial count.
		rates.push({ rate: (Math.max(cur.tokens - prev.tokens, 0) / span) * 1000, span });
	}
	return rates;
}

/**
 * History key for the active model. Keyed per model, not per session: the
 * same provider+model behaves consistently across sessions and subagents,
 * which is exactly what makes a cross-response distribution meaningful.
 */
function rateKey(ctx: ExtensionContext | undefined): string | undefined {
	const model = ctx?.model as { provider?: unknown; id?: unknown } | undefined;
	const provider = typeof model?.provider === "string" ? model.provider : undefined;
	const id = typeof model?.id === "string" ? model.id : undefined;
	if (!provider || !id) return undefined;
	return `${provider}/${id}`;
}

/**
 * Record one response's observed rates as HISTORY_SEGMENTS robust samples.
 *
 * Uses the response's OWN cycle rates (not the gate-passing subset): a gate fed
 * only by values it already accepts is a one-way ratchet that can never adapt
 * upward when the model genuinely gets faster.
 */
function recordResponseHistory(store: SharedStore, key: string, samples: SpeedSample[]): void {
	const rates = cycleRates(samples, SPEED_MAX_SAMPLES);
	if (rates.length < HISTORY_MIN_CYCLES) return;
	const cycleValues = rates.map((cycle) => cycle.rate);

	let history = store.history.get(key);
	if (!history) {
		history = { samples: [], next: 0 };
		store.history.set(key, history);
	}
	const size = Math.floor(cycleValues.length / HISTORY_SEGMENTS);
	for (let i = 0; i < HISTORY_SEGMENTS; i++) {
		const segment = cycleValues.slice(
			i * size,
			i === HISTORY_SEGMENTS - 1 ? cycleValues.length : (i + 1) * size,
		);
		const value = median(segment);
		if (value === undefined || !(value > 0)) continue;
		if (history.samples.length < HISTORY_CAP) history.samples.push(value);
		else {
			history.samples[history.next] = value;
			history.next = (history.next + 1) % HISTORY_CAP;
		}
	}
}

/**
 * Derive the plausibility bound for a model from its observed rates.
 * Returns undefined while the history is too small — an unknown model must
 * never be censored on the basis of "we have not seen it before".
 *
 * MAD rather than standard deviation: with 20% of samples at 20x, the bound
 * moved 212 -> 230 tok/s in measurement, where a standard deviation would be
 * dragged upward by the very spikes the gate exists to reject.
 */
function plausibilityBound(store: SharedStore, key: string | undefined): Gate | undefined {
	if (key === undefined) return undefined;
	const history = store.history.get(key);
	if (!history || history.samples.length < HISTORY_MIN_SAMPLES) return undefined;

	const center = median(history.samples);
	if (center === undefined || !(center > 0)) return undefined;
	const deviations = history.samples.map((value) => Math.abs(value - center));
	const mad = median(deviations) ?? 0;
	const spread = Math.max(mad * MAD_TO_SIGMA, center * GATE_SPREAD_FLOOR);
	return { median: center, bound: center + GATE_K * spread };
}

/**
 * Streaming speed estimate: the median of the recent cycle rates that pass the
 * plausibility gate, with a minimum while the window is still small.
 *
 * Returns undefined until SPEED_MIN_CYCLES plausible cycles exist; the caller
 * keeps showing the previous speed until then (see speedTextFor). With no gate
 * (an unknown model) nothing is filtered — "we have not seen this model" must
 * never be a reason to censor its speed.
 */
function estimateStreamSpeed(samples: SpeedSample[], gate?: Gate): number | undefined {
	const rates = cycleRates(samples, SPEED_WINDOW);
	const plausible = gate ? rates.filter((cycle) => cycle.rate <= gate.bound) : rates;
	if (plausible.length < SPEED_MIN_CYCLES) return undefined;
	// Small window: the minimum is the only honest reading (same reason as
	// before — a median needs outliers to stay a minority, and rank is
	// meaningless while there are too few cycles to rank).
	if (plausible.length < SPEED_SMALL_WINDOW) {
		const lightest = Math.min(...plausible.map((cycle) => cycle.rate));
		return lightest;
	}
	const weighted = weightedMedian(plausible);
	if (weighted !== undefined) return weighted;
	return median(plausible.map((cycle) => cycle.rate));
}

/** Append a sample and bound the buffer by COUNT only (see SPEED_MAX_SAMPLES). */
function pushSample(samples: SpeedSample[], sample: SpeedSample): void {
	samples.push(sample);
	while (samples.length > SPEED_MAX_SAMPLES) {
		samples.shift();
	}
}

function formatSpeed(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) {
		return "—";
	}

	return tokens >= 100 ? tokens.toFixed(0) : tokens.toFixed(1);
}

function formatLatency(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) {
		return "—";
	}

	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Strip the disambiguation suffix pi-subagents appends ("Explore#a1b2c3d4") and cap width. */
function shortLabel(label: string | undefined): string {
	const base = (label ?? "").split("#")[0].trim();
	if (!base) return "";
	return base.length > MAX_LABEL_WIDTH ? `${base.slice(0, MAX_LABEL_WIDTH - 1)}…` : base;
}

/**
 * Aggregate segment for the other sessions that are still executing (the subagents).
 *
 * The label follows the EXECUTING count — stable across the agents' streaming gaps —
 * never the momentary streaming count, so it doesn't flip between a name and "N sub".
 * The speed part is shown only while at least one agent streams; during a global lull
 * the bare count is displayed instead of a meaningless "—".
 */
function formatSubagents(sessions: SessionEntry[], now: number): string {
	if (sessions.length === 0) return "";
	// Each agent contributes its CURRENT speed while streaming. Between
	// responses it contributes its last measured one, but only briefly: an agent
	// parked in a long tool phase must not keep adding a frozen rate to the sum
	// (that is what made a finished burst inflate the aggregate forever).
	const speed = sessions.reduce((sum, entry) => {
		if (entry.speed !== undefined && entry.speed > 0) return sum + entry.speed;
		if (
			entry.lastSpeed !== undefined &&
			entry.lastSpeed > 0 &&
			entry.speedAt !== undefined &&
			now - entry.speedAt <= AGGREGATE_SPEED_TTL_MS
		) {
			return sum + entry.lastSpeed;
		}
		return sum;
	}, 0);
	const who =
		sessions.length === 1
			? `sub ${shortLabel(sessions[0].label) || "1"}`
			: `${sessions.length} sub`;
	// Only a session that has never streamed yet contributes nothing — bare count.
	return speed > 0 ? `${who} · ${formatSpeed(speed)} tok/s` : who;
}

function getSessionLabel(pi: ExtensionAPI): string | undefined {
	try {
		const name = (pi as { getSessionName?: () => string | undefined }).getSessionName?.();
		return name?.trim() ? name.trim() : undefined;
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const store = getStore();
	// One extension instance per session (pi re-evaluates the module per subagent
	// spawn and calls the factory again), so a random id uniquely identifies this
	// session's entry in the shared store.
	const instanceId = randomUUID();

	let activeResponse: SpeedState | undefined;
	let live: LiveSpeed | undefined;
	let awaitingFirstToken = false;
	let lastFinalMainStatus: string | undefined;
	/** Last speed displayed in this session (live estimate or final). Once a
	 *  speed has been shown, later TTFT waits and sample-starved phases keep it on screen
	 *  instead of reverting to the "..." placeholder — only a session that has
	 *  never shown a speed falls back to "...". */
	let lastShownSpeed: number | undefined;
	/** Throttle for THIS session's own streaming renders (main only; flushes bypass). */
	let lastLiveRenderAt = -Infinity;
	/** Throttle for streaming reports into the store — must also apply to UI-less subagent instances. */
	let lastReportAt = -Infinity;
	let pendingRequestSentAt: number | undefined;
	let latestCtx: ExtensionContext | undefined;

	// Compose this session's segment with the live subagent aggregate and push it
	// to the footer. Only the instance whose session owns a real UI renders — for
	// every subagent instance this is a no-op (pi hands children a no-op UI),
	// which is exactly why they report into the store instead.
	//
	// force=true (store flushes, phase changes) renders immediately and never
	// advances the streaming throttle — flushes must not starve this session's
	// own ~10Hz streaming cadence. throttle=true is that cadence.

	/** Speed text for phases without a fresh sample (TTFT wait, estimator warmup):
	 *  once this session has shown a speed, keep showing it — never revert to "...". */
	const speedTextFor = (current?: number): string => {
		const speed = current !== undefined && current > 0 ? current : lastShownSpeed;
		return speed !== undefined && speed > 0 ? formatSpeed(speed) : "...";
	};

	const render = (force = false, throttle = false) => {
		try {
			const ctx = latestCtx;
			if (!ctx?.hasUI) return;

			const now = performance.now();
			if (!force && throttle && now - lastLiveRenderAt < LIVE_REFRESH_INTERVAL_MS) return;
			if (throttle) lastLiveRenderAt = now;

			pruneStaleSessions(store, now);
			const subs = [...store.sessions]
				.filter(([id]) => id !== instanceId)
				.map(([, entry]) => entry)
				.filter((entry) => entry.running);
			const subSegment = formatSubagents(subs, now);

			let status: string | undefined;
			// The main session's own speed is always displayed once measured: live
			// while streaming, otherwise the last finalized speed — subagent activity
			// appends to it, never replaces it.
			let mainSegment: string | undefined;
			if (live && awaitingFirstToken) {
				// Live TTFT wait (message started, first token pending): tick the time
				// since the request was sent — the same anchor the final TTFT is
				// measured from — so the running number converges exactly to the value
				// frozen at the first token.
				const anchor = activeResponse?.requestSentAt ?? pendingRequestSentAt;
				mainSegment =
					anchor !== undefined
						? `⚡ ${speedTextFor()} tok/s · TTFT ${formatLatency(Math.max(now - anchor, 0))}…`
						: `⚡ ${speedTextFor()} tok/s · TTFT ...`;
			} else if (live) {
				// TTFT is final the moment the first token arrives — show it even while
				// the estimator still lacks history, where only the speed is withheld.
				mainSegment = `⚡ ${speedTextFor(live.speed)} tok/s · TTFT ${formatLatency(live.ttft ?? Number.NaN)}`;
			} else if (pendingRequestSentAt !== undefined) {
				// Live TTFT wait (request in flight, message not started yet): the
				// network/provider latency before message_start is part of the TTFT.
				mainSegment = `⚡ ${speedTextFor()} tok/s · TTFT ${formatLatency(Math.max(now - pendingRequestSentAt, 0))}…`;
			} else {
				mainSegment = lastFinalMainStatus;
			}
			if (mainSegment && subSegment) status = `${mainSegment} · ${subSegment}`;
			else if (mainSegment) status = mainSegment;
			else if (subSegment) status = `⚡ ${subSegment}`;

			ctx.ui.setStatus(STATUS_KEY, status);
		} catch {
			// stale ctx (session replaced/reloaded) — display-only, never break the session
		}
	};

	const onStoreChange = () => render(true);

	// Live TTFT wait timer. No pi event fires between the provider request and
	// the first streamed token, so a timer is the only way to keep the wait
	// visible: every tick is a forced render of the elapsed time at ~10Hz.
	let waitTicker: ReturnType<typeof setInterval> | undefined;
	const stopWaitTicker = () => {
		if (waitTicker !== undefined) {
			clearInterval(waitTicker);
			waitTicker = undefined;
		}
	};
	const startWaitTicker = () => {
		// Only the UI-owning instance renders; subagent instances must not even
		// start one — an interval would achieve nothing and keep the process alive.
		if (latestCtx?.hasUI !== true || waitTicker !== undefined) return;
		waitTicker = setInterval(() => render(true), LIVE_REFRESH_INTERVAL_MS);
		// Defense in depth: a leaked interval must never hold the process open.
		waitTicker.unref?.();
	};

	/** Merge a patch into this session's store entry and refresh its keepalive. */
	const touch = (patch: Partial<Omit<SessionEntry, "updatedAt">>) => {
		const now = performance.now();
		const entry = store.sessions.get(instanceId);
		if (entry) {
			Object.assign(entry, patch);
			entry.updatedAt = now;
		} else {
			store.sessions.set(instanceId, { running: false, ...patch, updatedAt: now });
		}
	};

	/** Report a streaming sample. `lastSpeed` is preserved while no estimate exists. */
	const reportSpeed = (speed: number | undefined) => {
		const now = performance.now();
		const entry = store.sessions.get(instanceId);
		// `speed === undefined` means "not enough history yet": keep the previous
		// sample's lastSpeed so the aggregate does not blink during the first
		// ~200ms of a response.
		const lastSpeed = speed !== undefined && speed > 0 ? speed : entry?.lastSpeed;
		const speedAt = speed !== undefined && speed > 0 ? now : entry?.speedAt;
		if (entry) {
			entry.speed = speed;
			entry.lastSpeed = lastSpeed;
			entry.speedAt = speedAt;
			entry.updatedAt = now;
		} else {
			store.sessions.set(instanceId, {
				running: false,
				speed,
				lastSpeed,
				speedAt,
				updatedAt: now,
			});
		}
	};

	const resetResponse = () => {
		activeResponse = undefined;
		live = undefined;
		awaitingFirstToken = false;
		pendingRequestSentAt = undefined;
		lastLiveRenderAt = -Infinity;
		lastReportAt = -Infinity;
		stopWaitTicker();
	};

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		resetResponse();
		lastFinalMainStatus = undefined;
		lastShownSpeed = undefined;
		store.renderers.add(onStoreChange);
		// Alive from now on; pi-subagents names the session before binding
		// extensions, so the label is already final here.
		touch({ running: true, speed: undefined, label: getSessionLabel(pi) });
		// The footer owner must see the new executing agent immediately.
		scheduleFlush(store);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// Keepalive only: these events don't change what the footer shows, but prove
	// the session is alive while it works (e.g. a long tool execution with no
	// streaming) so the TTL prune can't drop a healthy entry.
	const keepAlive = async (_event: unknown, ctx: ExtensionContext) => {
		latestCtx = ctx;
		touch({});
	};
	pi.on("agent_start", keepAlive);
	pi.on("turn_start", keepAlive);
	pi.on("turn_end", keepAlive);
	pi.on("tool_execution_start", keepAlive);
	pi.on("tool_execution_update", keepAlive);
	pi.on("tool_execution_end", keepAlive);

	pi.on("before_provider_request", async (_event, ctx) => {
		latestCtx = ctx;
		pendingRequestSentAt = performance.now();
		// The TTFT wait starts with the request itself: start the live timer and
		// show the elapsed immediately instead of waiting for message_start.
		startWaitTicker();
		render(true);
	});

	pi.on("message_start", async (event, ctx) => {
		latestCtx = ctx;
		if (!asAssistantMessage(event.message)) {
			return;
		}

		activeResponse = {
			startedAt: performance.now(),
			requestSentAt: pendingRequestSentAt,
			samples: [],
		};
		live = { tokens: 0, speed: undefined, ttft: undefined };
		awaitingFirstToken = true;
		touch({ running: true, speed: 0, label: getSessionLabel(pi) });
		// Defensive: keep the wait timer running even if before_provider_request
		// was somehow missed (the display anchor falls back to message start).
		startWaitTicker();
		render(true);
		scheduleFlush(store);
	});

	pi.on("message_update", async (event, ctx) => {
		latestCtx = ctx;
		const message = asAssistantMessage(event.message);
		if (!message || !activeResponse) {
			return;
		}

		const now = performance.now();
		if (activeResponse.firstTokenAt === undefined) {
			activeResponse.firstTokenAt = now;
			// First token received: the wait is over. Stop the live TTFT timer and
			// decouple "waiting" from the speed estimate so the final TTFT shows now.
			stopWaitTicker();
			awaitingFirstToken = false;
		}
		const ttft =
			activeResponse.requestSentAt !== undefined && activeResponse.firstTokenAt !== undefined
				? activeResponse.firstTokenAt - activeResponse.requestSentAt
				: undefined;

		// The full assistant message is always provided, even on the very first
		// update — so this sample carries the whole (possibly batched) first chunk,
		// and the naive "tokens since start" is what used to spike here.
		const outputTokens = getOutputTokens(message);
		pushSample(
			activeResponse.samples,
			{ at: now - activeResponse.startedAt, tokens: outputTokens },
		);
		const speed = estimateStreamSpeed(
			activeResponse.samples,
			plausibilityBound(store, rateKey(ctx)),
		);
		live = { tokens: outputTokens, speed, ttft };
		if (speed !== undefined && speed > 0) lastShownSpeed = speed;

		// Report and render at most ~10Hz. This gate MUST live outside the render:
		// UI-less subagent instances would otherwise report every single delta.
		if (now - lastReportAt < LIVE_REFRESH_INTERVAL_MS) {
			return;
		}
		lastReportAt = now;

		reportSpeed(speed);
		render(false, true);
		// A UI-less instance (subagent) can only reach the footer owner through the
		// store — its reports MUST flush. The owner renders its own streaming
		// through the throttled path above and must not flush on every delta.
		if (!latestCtx?.hasUI) scheduleFlush(store);
	});

	pi.on("message_end", async (event, ctx) => {
		latestCtx = ctx;
		const message = asAssistantMessage(event.message);
		if (!message || !activeResponse) {
			return;
		}

		const outputTokens = getOutputTokens(message);
		pushSample(
			activeResponse.samples,
			{ at: performance.now() - activeResponse.startedAt, tokens: outputTokens },
		);
		// Final speed: the same estimator the streaming display used, so the number
		// the user was reading does not jump at the end. `usage.output / elapsed` is
		// only a fallback for a response that was too short to measure (one delta,
		// so there is no rate to observe) — it is a throughput that includes the
		// prefill, which is why a 100-token answer that completes in 200ms would
		// otherwise be reported as hundreds of tok/s and stay on screen.
		const gate = plausibilityBound(store, rateKey(ctx));
		const estimated = estimateStreamSpeed(activeResponse.samples, gate);
		// A response too short to measure has no observable cycle; fall back to
		// usage.output / elapsed — which includes the prefill, so it is a
		// throughput, not a rate. Clamp it to the model's plausible range so a
		// 200ms/1000-token reply cannot freeze an absurd value on the footer.
		// With no history there is nothing to clamp against, so it is shown as-is.
		const formula = tokensPerSecond(outputTokens, activeResponse.startedAt);
		const speed =
			estimated !== undefined && estimated > 0
				? estimated
				: gate !== undefined
					? Math.min(formula, gate.bound)
					: formula;
		const ttft =
			activeResponse.requestSentAt !== undefined && activeResponse.firstTokenAt !== undefined
				? activeResponse.firstTokenAt - activeResponse.requestSentAt
				: undefined;
		if (speed > 0) lastShownSpeed = speed;
		lastFinalMainStatus = `⚡ ${formatSpeed(speed)} tok/s · TTFT ${formatLatency(ttft ?? Number.NaN)}`;

		// Feed the plausibility history before the response state is dropped.
		const historyKey = rateKey(ctx);
		if (historyKey !== undefined) {
			recordResponseHistory(store, historyKey, activeResponse.samples);
		}

		// A message can end without ever streaming (empty response): the wait
		// timer must not outlive it.
		stopWaitTicker();
		live = undefined;
		awaitingFirstToken = false;
		activeResponse = undefined;
		pendingRequestSentAt = undefined;
		lastLiveRenderAt = -Infinity;
		lastReportAt = -Infinity;
		// Still running (more turns may follow) — just no longer streaming.
		// Clearing the current speed also stamps the aggregate expiry clock.
		touch({ speed: undefined });
		render(true);
		// The aggregate changed for the footer owner (if this isn't it).
		scheduleFlush(store);
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		// Safety net for failed/aborted requests: they never reach message_*, so
		// the live TTFT timer is stopped here instead — and the request anchor is
		// dropped, or later renders would show a frozen wait time.
		stopWaitTicker();
		pendingRequestSentAt = undefined;
		// The agent is done executing — drop it from the count immediately, even
		// though its session lingers for a while before pi-subagents disposes it.
		store.sessions.delete(instanceId);
		scheduleFlush(store);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		store.renderers.delete(onStoreChange);
		store.sessions.delete(instanceId);
		resetResponse();
		lastFinalMainStatus = undefined;
		lastShownSpeed = undefined;
		// Drop the context so trailing renders can't touch a session that is gone.
		latestCtx = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
