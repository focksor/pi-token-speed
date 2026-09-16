import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-speed";
const LIVE_REFRESH_INTERVAL_MS = 100;
/**
 * Since-start averages are meaningless in the first moments of a response: a
 * fat first chunk over a near-zero elapsed (floored at 1ms) computes absurd
 * tok/s values that then decay — and the aggregate sums that spike across
 * agents. Hide the speed until a response has this much history.
 */
const SPEED_WARMUP_MS = 1000;
/** Safety net: drop sessions whose instance stopped reporting without a clean end (crash/kill). */
const SESSION_TTL_MS = 5 * 60_000;
/** Width cap for a single subagent label in the footer. */
const MAX_LABEL_WIDTH = 16;

interface SpeedState {
	startedAt: number;
	requestSentAt?: number;
	firstTokenAt?: number;
}

interface LiveSpeed {
	tokens: number;
	speed: number;
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
	/** Last measured (post-warmup) speed for this session — shown when it is
	 *  not currently streaming, mirroring the main session's persist-last-final
	 *  behavior. Cleared implicitly when the entry is removed (agent end). */
	lastSpeed?: number;
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
function formatSubagents(sessions: SessionEntry[]): string {
	if (sessions.length === 0) return "";
	// Each agent contributes its CURRENT speed while streaming, otherwise its
	// last measured one — so the aggregate keeps showing a speed whenever there
	// is subagent activity (matching the main segment's persist-last-final rule)
	// instead of dropping to a bare count at every tool/turn gap.
	const speed = sessions.reduce(
		(sum, entry) =>
			sum +
			(entry.speed !== undefined && entry.speed > 0 ? entry.speed : (entry.lastSpeed ?? 0)),
		0,
	);
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
			const subSegment = formatSubagents(subs);

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
						? `⚡ ... tok/s · TTFT ${formatLatency(Math.max(now - anchor, 0))}…`
						: "⚡ ... tok/s · TTFT ...";
			} else if (live) {
				// TTFT is final the moment the first token arrives — show it even during
				// the speed warmup, where only the speed stays hidden.
				const speedText = live.speed > 0 ? formatSpeed(live.speed) : "...";
				mainSegment = `⚡ ${speedText} tok/s · TTFT ${formatLatency(live.ttft ?? Number.NaN)}`;
			} else if (pendingRequestSentAt !== undefined) {
				// Live TTFT wait (request in flight, message not started yet): the
				// network/provider latency before message_start is part of the TTFT.
				mainSegment = `⚡ ... tok/s · TTFT ${formatLatency(Math.max(now - pendingRequestSentAt, 0))}…`;
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

	/** Report a streaming sample. `lastSpeed` is preserved across warmup zeros. */
	const reportSpeed = (speed: number) => {
		const now = performance.now();
		const entry = store.sessions.get(instanceId);
		const lastSpeed = speed > 0 ? speed : entry?.lastSpeed;
		if (entry) {
			entry.speed = speed;
			entry.lastSpeed = lastSpeed;
			entry.updatedAt = now;
		} else {
			store.sessions.set(instanceId, { running: false, speed, lastSpeed, updatedAt: now });
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
		};
		live = { tokens: 0, speed: 0, ttft: undefined };
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
			// decouple "waiting" from the speed warmup so the final TTFT shows now.
			stopWaitTicker();
			awaitingFirstToken = false;
		}
		const ttft =
			activeResponse.requestSentAt !== undefined && activeResponse.firstTokenAt !== undefined
				? activeResponse.firstTokenAt - activeResponse.requestSentAt
				: undefined;

		// Always keep the local snapshot fresh — even when throttled — so any
		// forced render (e.g. a flush caused by another session) shows the
		// CURRENT main-segment values instead of a stale placeholder.
		const outputTokens = getOutputTokens(message);
		const warmup = now - activeResponse.startedAt < SPEED_WARMUP_MS;
		const speed = warmup ? 0 : tokensPerSecond(outputTokens, activeResponse.startedAt);
		live = { tokens: outputTokens, speed, ttft };

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
		const speed = tokensPerSecond(outputTokens, activeResponse.startedAt);
		const ttft =
			activeResponse.requestSentAt !== undefined && activeResponse.firstTokenAt !== undefined
				? activeResponse.firstTokenAt - activeResponse.requestSentAt
				: undefined;
		lastFinalMainStatus = `⚡ ${formatSpeed(speed)} tok/s · TTFT ${formatLatency(ttft ?? Number.NaN)}`;

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
		// Drop the context so trailing renders can't touch a session that is gone.
		latestCtx = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
