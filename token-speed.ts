import { performance } from "node:perf_hooks";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-speed";
const LIVE_REFRESH_INTERVAL_MS = 100;

interface SpeedState {
	startedAt: number;
	requestSentAt?: number;
	firstTokenAt?: number;
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

export default function (pi: ExtensionAPI) {
	let activeResponse: SpeedState | undefined;
	let lastLiveRenderAt = 0;
	let pendingRequestSentAt: number | undefined;

	pi.on("session_start", async (_event, ctx) => {
		activeResponse = undefined;
		lastLiveRenderAt = 0;
		pendingRequestSentAt = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_provider_request", async () => {
		pendingRequestSentAt = performance.now();
	});

	pi.on("message_start", async (event, ctx) => {
		if (!asAssistantMessage(event.message)) {
			return;
		}

		activeResponse = {
			startedAt: performance.now(),
			requestSentAt: pendingRequestSentAt,
		};
		lastLiveRenderAt = 0;
		ctx.ui.setStatus(STATUS_KEY, "⚡ ... tok/s · TTFT ...");
	});

	pi.on("message_update", async (event, ctx) => {
		const message = asAssistantMessage(event.message);
		if (!message || !activeResponse) {
			return;
		}

		const now = performance.now();
		if (activeResponse.firstTokenAt === undefined) {
			activeResponse.firstTokenAt = now;
		}

		if (now - lastLiveRenderAt < LIVE_REFRESH_INTERVAL_MS) {
			return;
		}

		const outputTokens = getOutputTokens(message);
		const speed = tokensPerSecond(outputTokens, activeResponse.startedAt);
		const ttft =
			activeResponse.requestSentAt !== undefined && activeResponse.firstTokenAt !== undefined
				? activeResponse.firstTokenAt - activeResponse.requestSentAt
				: undefined;
		ctx.ui.setStatus(
			STATUS_KEY,
			`⚡ ${formatSpeed(speed)} tok/s · TTFT ${formatLatency(ttft ?? Number.NaN)}`,
		);
		lastLiveRenderAt = now;
	});

	pi.on("message_end", async (event, ctx) => {
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
		ctx.ui.setStatus(
			STATUS_KEY,
			`⚡ ${formatSpeed(speed)} tok/s · TTFT ${formatLatency(ttft ?? Number.NaN)}`,
		);

		activeResponse = undefined;
		pendingRequestSentAt = undefined;
		lastLiveRenderAt = 0;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeResponse = undefined;
		lastLiveRenderAt = 0;
		pendingRequestSentAt = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
