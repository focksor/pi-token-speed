# 到达周期速度估计与历史可行域闸门 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `token-speed.ts` 的流式速度估计器从"墙钟分桶中位数"替换为"到达周期 + 历史导出的可行域闸门"，消除"高于常理"的速度读数。

**Architecture:** 估计器改为在**相邻带 token 到达之间**测量周期速率（零 token 事件天然不成周期）；窗口小时取 min、够大取中位数；再叠加一个按 (provider, model) 键控的**内存历史环**导出可行域闸门（`median + 6 × max(1.4826·MAD, 0.3·median)`），超出者静默。冷启动无历史时不剔除、不夹紧。

**Tech Stack:** TypeScript 单文件 pi 扩展（运行时零依赖），`node:test` 无——测试用脚本式断言 + 虚拟时钟（patch `performance.now`）。Node 24 原生跑 `.ts`。

**Spec:** `docs/superpowers/specs/2026-09-20-token-speed-glitch-design.md`（已批准，commit `afa5d2b`）

## Global Constraints

- 运行时**零第三方依赖**：`token-speed.ts` 只 import `node:crypto`、`node:perf_hooks`，以及 type-only 的 pi 包。
- **不得引入任何磁盘 IO**：历史仅存内存（挂在现有 `globalThis` 共享 store 上）。
- **不得写死速度阈值**：所有可行域边界由历史分布导出；允许写死的只有结构参数（窗口大小、样本数、K、分段数、最少样本数）。
- 保留既有行为：`lastShownSpeed` 速度不回退、TTFT 实时等待计时、subagent 聚合与 label 规则、`/reload` 的 store 字段级防御式迁移、UI-less 实例不上报 UI。
- 每个任务结束时 `node test-global.ts`（33 项）、`node token-speed.ts`（加载冒烟）、`tsc --strict` 必须全绿。
- 提交信息用英文，遵循仓库既有的 `feat:` / `fix:` / `docs:` 前缀风格。
- 常量命名沿用现有风格：`SPEED_*` 前缀、大写蛇形、带 JSDoc 注释说明**为什么**。

---

### Task 1: 到达周期采样（替换墙钟分桶）

**Files:**
- Modify: `token-speed.ts:12-32`（常量块）、`token-speed.ts:196-264`（估计器与裁剪）、`token-speed.ts:217`（调用点签名）

**Interfaces:**
- Consumes: 现有 `SpeedSample { at: number; tokens: number }`、`SpeedState.samples`。
- Produces:
  - `pushSample(samples: SpeedSample[], sample: SpeedSample): void` — 签名不变，裁剪策略改为仅按数量。
  - `estimateStreamSpeed(samples: SpeedSample[]): number | undefined` — 签名不变，实现替换。
  - 新常量：`SPEED_WINDOW = 8`、`SPEED_SMALL_WINDOW = 5`、`SPEED_MIN_CYCLES = 2`。
  - 新内部函数：`cycleRates(samples: SpeedSample[], keep: number): number[]`（返回尾部至多 `keep` 个周期速率，供 Task 2 复用于历史采样）。

- [ ] **Step 1: 写失败测试**

创建 `test-estimator.ts`：

```ts
/**
 * 虚拟时钟驱动的估计器回归测试。patch performance.now 后驱动真实扩展代码，
 * 断言 footer 实际显示的数值序列。运行：node test-estimator.ts
 */
import { performance } from "node:perf_hooks";

// ── 虚拟时钟：必须在导入扩展之前装好 ────────────────────────────────────────
let clock = 0;
const realNow = performance.now.bind(performance);
performance.now = () => clock;
const advance = (ms: number) => {
	clock += ms;
};

const { default: extensionFactory } = await import("./token-speed.ts");

/** 每个实例用一组独立的 handler 表模拟一个 pi 会话。 */
function createInstance(hasUI = true, model?: { provider: string; id: string }) {
	const handlers = new Map<string, Array<(e: unknown, c: unknown) => void>>();
	const pi = {
		on: (t: string, h: (e: unknown, c: unknown) => void) => {
			if (!handlers.has(t)) handlers.set(t, []);
			handlers.get(t)!.push(h);
		},
	};
	extensionFactory(pi as never);
	const shown: Array<number | undefined> = [];
	const ctx = {
		hasUI,
		model: model ? { provider: model.provider, id: model.id } : undefined,
		ui: {
			setStatus: (_k: string, v?: string) => {
				if (v === undefined) return;
				// 只读 MAIN 段：subagent 聚合追加在 " · " 之后，其求和值
				// 绝不能被当作本会话的速度。
				const main = v.split(" · ").slice(0, 3).join(" · ");
				const m =
					/^(?:⚡ )?([\d.]+|\.\.\.) tok\/s/.exec(v.trim())?.[1] ??
					/([\d.]+|\.\.\.) tok\/s/.exec(main)?.[1];
				shown.push(m === undefined || m === "..." ? undefined : Number(m));
			},
		},
	};
	return {
		fire: async (t: string, e: unknown = {}) => {
			for (const h of handlers.get(t) ?? []) await h(e, ctx);
		},
		shown,
	};
}

const msg = (tokens: number) => ({
	role: "assistant",
	content: [{ type: "text", text: "x".repeat(tokens * 4) }],
	usage: { output: 0 },
});

/** 流式：steps 为 [间隔ms, 累计token] 列表。 */
async function stream(inst: ReturnType<typeof createInstance>, steps: Array<[number, number]>) {
	await inst.fire("session_start", {});
	await inst.fire("before_provider_request");
	await inst.fire("message_start", { message: msg(0) });
	for (const [dt, tokens] of steps) {
		advance(dt);
		await inst.fire("message_update", { message: msg(tokens) });
	}
	advance(10);
	await inst.fire("message_end", { message: msg(steps.at(-1)![1]) });
	// 从共享 store 中清除本会话：残留会话会出现在其他实例的 subagent 聚合段里。
	await inst.fire("session_shutdown", {});
	await inst.fire("agent_end", {});
	return inst.shown;
}

let failures = 0;
const expect = (condition: boolean, message: string) => {
	if (condition) console.log(`ok: ${message}`);
	else {
		failures++;
		console.error(`FAIL: ${message}`);
	}
};

const peak = (xs: Array<number | undefined>) => {
	const v = xs.filter((x): x is number => x !== undefined);
	return v.length ? Math.max(...v) : undefined;
};
const final = (xs: Array<number | undefined>) => xs.filter((x): x is number => x !== undefined).at(-1);

const clean = (n: number) => Array.from({ length: n }, (_, i) => [50, (i + 1) * 5] as [number, number]);

// [regression] 早期窗口被两个相邻肥 chunk 污染：既有实现显示 5100，新规则须为 100
{
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 24; i++) {
		acc += 5 + (i === 2 || i === 3 ? 500 : 0);
		steps.push([50, acc]);
	}
	const shown = await stream(createInstance(true, { provider: "p", id: "cold-early" }), steps);
	expect(peak(shown)! <= 150, `early adjacent fat chunks stay near 100 (peak ${peak(shown)})`);
	expect(Math.abs(final(shown)! - 100) < 1, `and settle at 100 (final ${final(shown)})`);
}

// 稳态无污染：必须如实显示 100
{
	const shown = await stream(createInstance(true, { provider: "p", id: "cold-steady" }), clean(24));
	expect(peak(shown)! <= 101 && Math.abs(final(shown)! - 100) < 1, `steady 100 shows 100 (${shown.join(",")})`);
}

performance.now = realNow;
if (failures > 0) {
	console.error(`\n${failures} check(s) failed.`);
	process.exit(1);
}
console.log("\nAll checks passed.");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test-estimator.ts`
Expected: FAIL — `early adjacent fat chunks stay near 100` 失败（既有实现显示 5100）。

- [ ] **Step 3: 替换常量块**

把 `token-speed.ts:12-32` 的整块常量替换为（删除 `SPEED_BUCKET_*`、`SPEED_BUCKETS_KEPT`、`SPEED_MIN_BUCKETS`、`SPEED_GUARD_RATIO`、`SPEED_WINDOW_MAX_MS`）：

```ts
/**
 * Speed estimator window: how many recent CYCLES back the live estimate looks.
 * A cycle is measured between two token-carrying arrivals, so a fat delta can
 * only ever pollute its own cycle instead of a wall-clock bucket that mixes a
 * stall with several bursts.
 */
const SPEED_WINDOW = 8;
/**
 * Below this many cycles the window takes the MINIMUM instead of the median.
 * A median only discards outliers while they stay a minority; with a 3-cycle
 * window two polluted cycles already carry it (measured: 2600 tok/s against a
 * true 100). The minimum is the only honest reading when data is scarce.
 */
const SPEED_SMALL_WINDOW = 5;
/** Fewest cycles that can produce a rate at all (2 intervals = 3 arrivals). */
const SPEED_MIN_CYCLES = 2;
/**
 * Sample buffer bound. Indices only — there is deliberately NO time-based
 * cutoff: a provider that emits a delta every 300ms+ would leave fewer than
 * SPEED_WINDOW+1 arrivals in any short time window, so the cycle window could
 * never fill and the footer would show no speed at all (measured: 3 arrivals
 * retained under the former 1800ms cutoff).
 */
const SPEED_MAX_SAMPLES = 512;
```

- [ ] **Step 4: 替换估计器与裁剪函数**

把 `token-speed.ts:196-264` 中从 `/** Streaming speed estimate...` 注释开始的 `estimateStreamSpeed` 与 `pushSample` 全部替换为：

```ts
/**
 * Per-cycle rates: the rate of each interval between two token-carrying
 * arrivals, most recent `keep` cycles first-to-last.
 *
 * A zero-token arrival cannot open a cycle, so role-only, finish_reason,
 * usage-only and heartbeat events cannot pollute the estimate at all — the
 * former bucketing had to absorb them, which either flickered to 0 or (if
 * dropped) inflated by the reciprocal of the content ratio.
 */
function cycleRates(samples: SpeedSample[], keep: number): number[] {
	// Indices of arrivals that carry tokens (the first sample counts only if
	// it already does — the initial message_start sample never does).
	const content: number[] = [];
	for (let i = 0; i < samples.length; i++) {
		const grew =
			i === 0 ? samples[i].tokens > 0 : samples[i].tokens > samples[i - 1].tokens;
		if (grew) content.push(i);
	}

	const rates: number[] = [];
	const from = Math.max(1, content.length - keep);
	for (let k = from; k < content.length; k++) {
		const prev = samples[content[k - 1]];
		const cur = samples[content[k]];
		const span = cur.at - prev.at;
		if (span <= 0) continue;
		// Clamp: a message rewritten mid-stream can lower the partial count.
		rates.push((Math.max(cur.tokens - prev.tokens, 0) / span) * 1000);
	}
	return rates;
}

/**
 * Streaming speed estimate: the median of the recent cycle rates, with a
 * minimum while the window is still small.
 *
 * Returns undefined until SPEED_MIN_CYCLES cycles exist; the caller keeps
 * showing the previous speed until then (see speedTextFor).
 */
function estimateStreamSpeed(samples: SpeedSample[]): number | undefined {
	const rates = cycleRates(samples, SPEED_WINDOW);
	if (rates.length < SPEED_MIN_CYCLES) return undefined;
	if (rates.length < SPEED_SMALL_WINDOW) return Math.min(...rates);
	return median(rates);
}

/** Append a sample and bound the buffer by COUNT only (see SPEED_MAX_SAMPLES). */
function pushSample(samples: SpeedSample[], sample: SpeedSample): void {
	samples.push(sample);
	while (samples.length > SPEED_MAX_SAMPLES) {
		samples.shift();
	}
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node test-estimator.ts`
Expected: PASS — 2 项检查全绿。

- [ ] **Step 6: 跑既有回归与类型检查**

Run: `node test-global.ts && npx tsc --module nodenext --moduleResolution nodenext --target es2022 --strict --noEmit --skipLibCheck --types node token-speed.ts`
Expected: `All checks passed.` + tsc 无输出退出码 0。

- [ ] **Step 7: 提交**

```bash
git add token-speed.ts test-estimator.ts
git commit -m "fix: measure speed per token-carrying arrival cycle, not wall-clock buckets

A wall-clock bucket mixes a stall with several bursts and lets unrelated
events share one measurement unit; two ADJACENT fat deltas put two polluted
buckets in a 3-bucket window and the median followed them (2600 tok/s
against a true 100). Cycles between token-carrying arrivals confine a fat
delta to its own cycle, and zero-token events cannot open a cycle at all.

The window takes the minimum below SPEED_SMALL_WINDOW cycles, because a
median is only outlier-proof while outliers stay a minority. Drops the
time-based sample cutoff: it left only 3 arrivals for a provider emitting
a delta every 300ms+, so the cycle window could never fill."
```

---

### Task 2: 历史环 + 闸门接入 + 超短回复夹紧

**Files:**
- Modify: `token-speed.ts`（常量与类型、`SharedStore` 迁移、历史函数、`estimateStreamSpeed` 加闸门参数、两个调用点、`message_end` 写入历史、超短回复夹紧）
- Test: `test-estimator.ts`

**Interfaces:**
- Consumes: Task 1 的 `cycleRates(samples, keep)`、`median(values)`、`estimateStreamSpeed(samples)`。
- Produces:
  - `interface SpeedHistory { samples: number[]; next: number }`
  - `interface Gate { median: number; bound: number }`
  - `rateKey(ctx: ExtensionContext | undefined): string | undefined`
  - `recordResponseHistory(store: SharedStore, key: string, samples: SpeedSample[]): void`
  - `plausibilityBound(store: SharedStore, key: string | undefined): Gate | undefined`
  - `SharedStore.history: Map<string, SpeedHistory>`
  - `estimateStreamSpeed(samples: SpeedSample[], gate?: Gate): number | undefined` — **新增可选第二参数**
  - 超短回复路径：`final = gate ? Math.min(formula, gate.bound) : formula`
  - 新常量：`HISTORY_CAP = 32`、`HISTORY_MIN_SAMPLES = 12`、`HISTORY_SEGMENTS = 4`、`HISTORY_MIN_CYCLES`、`GATE_K = 6`、`MAD_TO_SIGMA = 1.4826`、`GATE_SPREAD_FLOOR = 0.3`

> **合并说明：** 本任务合并了原计划的 Task 2（历史存储）与 Task 3（闸门接入）。二者是同一功能的存储侧与消费侧；原拆分会让 Task 2 结束时有一项断言必然失败（闸门未接入），与 Global Constraints 的"每个任务结束必须全绿"冲突。Steps 1–6 为历史存储，Steps 7–9 为闸门接入与夹紧，Step 10 统一验证与提交。

- [ ] **Step 1: 写失败测试**

在 `test-estimator.ts` 的 `performance.now = realNow;` 之前追加：

```ts
// ── 历史环与闸门（通过真实模块的可观察行为验证） ──────────────────────────
// 训练一个模型键：连续 4 个健康 ~100 tok/s 响应后，闸门应启用；此后一个
// 20 倍 spike 响应不得把显示推到 5100。
{
	const key = { provider: "gate", id: "model-train" };
	for (let i = 0; i < 6; i++) {
		await stream(createInstance(true, key), clean(24));
	}
	const healthy = await stream(createInstance(true, key), clean(24));
	expect(Math.abs(final(healthy)! - 100) < 1, `trained history still shows the true 100 (${final(healthy)})`);

	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 24; i++) {
		acc += 5 + (i === 8 || i === 9 ? 500 : 0);
		steps.push([50, acc]);
	}
	const spiked = await stream(createInstance(true, key), steps);
	expect(peak(spiked)! <= 150, `trained gate suppresses adjacent fat chunks (peak ${peak(spiked)})`);
}

// 冷启动不误伤：无历史的键下，真实 2000 tok/s 必须原样显示
{
	const shown = await stream(
		createInstance(true, { provider: "gate", id: "cold-fast" }),
		Array.from({ length: 30 }, (_, i) => [10, (i + 1) * 20] as [number, number]),
	);
	expect(final(shown)! > 1900, `cold start shows a genuine 2000 tok/s (final ${final(shown)})`);
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test-estimator.ts`
Expected: FAIL — `trained gate suppresses adjacent fat chunks`（闸门尚未实现，显示到 2600）。

- [ ] **Step 3: 新增常量与类型**

在 Task 1 的 `SPEED_MAX_SAMPLES` 常量之后追加：

```ts
/**
 * Plausibility gate: a speed outside the model's own observed distribution is
 * far more likely to be an arrival artifact than a real rate. The bound is
 * DERIVED FROM HISTORY — never a hardcoded maximum — so a genuinely fast model
 * is not capped by a constant chosen for a slow one.
 */
const HISTORY_CAP = 32;
/** Samples needed before the gate activates (~3 responses at HISTORY_SEGMENTS). */
const HISTORY_MIN_SAMPLES = 12;
/**
 * Robust samples recorded per response: the response's cycles are split into
 * this many segments and each segment's median is stored. Segment medians keep
 * a single spike from moving the history, while still filling the ring fast
 * enough that the gate activates after a few responses (one sample per response
 * would take HISTORY_MIN_SAMPLES responses).
 */
const HISTORY_SEGMENTS = 4;
/** Segment count below which a response is too short to be evidence. */
const HISTORY_MIN_CYCLES = HISTORY_SEGMENTS * 2;
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
```

- [ ] **Step 4: 扩展共享 store 与迁移**

`SharedStore` 接口与 `getStore()` 各加一个字段（沿用既有的字段级防御式迁移模式）：

```ts
interface SharedStore {
	sessions: Map<string, SessionEntry>;
	/** Per (provider, model) observed cycle rates — the plausibility gate's input. */
	history: Map<string, SpeedHistory>;
	renderers: Set<() => void>;
	flushScheduled: boolean;
}
```

`getStore()` 内 store 字面量加：

```ts
		history: previous?.history instanceof Map ? previous.history : new Map(),
```

- [ ] **Step 5: 实现历史函数**

在 `median()` 之后（`estimateStreamSpeed` 之前）插入：

```ts
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

	let history = store.history.get(key);
	if (!history) {
		history = { samples: [], next: 0 };
		store.history.set(key, history);
	}
	const size = Math.floor(rates.length / HISTORY_SEGMENTS);
	for (let i = 0; i < HISTORY_SEGMENTS; i++) {
		const segment = rates.slice(
			i * size,
			i === HISTORY_SEGMENTS - 1 ? rates.length : (i + 1) * size,
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
```

- [ ] **Step 6: 在 message_end 写入历史**

在 `pi.on("message_end", ...)` 内、`stopWaitTicker();` 之前插入（**必须在 `activeResponse = undefined` 之前**）：

```ts
		// Feed the plausibility history before the response state is dropped.
		const historyKey = rateKey(ctx);
		if (historyKey !== undefined) {
			recordResponseHistory(store, historyKey, activeResponse.samples);
		}
```

- [ ] **Step 7: 给估计器加闸门参数**

把 Task 1 的 `estimateStreamSpeed` 替换为（新增可选 `gate` 参数，并给出完整函数体）：

```ts
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
	const plausible = gate ? rates.filter((rate) => rate <= gate.bound) : rates;
	if (plausible.length < SPEED_MIN_CYCLES) return undefined;
	if (plausible.length < SPEED_SMALL_WINDOW) return Math.min(...plausible);
	return median(plausible);
}
```

- [ ] **Step 8: 在两个调用点传入闸门**

`message_update` 中把 `const speed = estimateStreamSpeed(activeResponse.samples);` 替换为：

```ts
		const speed = estimateStreamSpeed(
			activeResponse.samples,
			plausibilityBound(store, rateKey(ctx)),
		);
```

`message_end` 中把 `const estimated = estimateStreamSpeed(activeResponse.samples);` 及其后的回退表达式替换为：

```ts
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
```

- [ ] **Step 9: 追加闸门行为测试**

在 `test-estimator.ts` 的 `performance.now = realNow;` 之前追加（闸门已在 Step 6 训练路径下生效，此处验证行为）：

```ts
// 诚实抖动不得被低估：周期速率交替 50/200（真实 125）显示须落在 [100,150]
{
	// 交替的周期速率为 50 与 200 tok/s、每段 1s：真实吞吐是 125 tok/s。
	// 因此 token 累计量须按每 1000ms 间隔增长 50/200。
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 12; i++) {
		acc += i % 2 ? 200 : 50;
		steps.push([1000, acc]);
	}
	const shown = await stream(createInstance(true, { provider: "gate", id: "jitter" }), steps);
	expect(
		final(shown)! >= 100 && final(shown)! <= 150,
		`honest jitter (rates 50/200, true 125) reads ~125, not 50 (final ${final(shown)})`,
	);
}

// 超短回复夹紧：1 delta / 50 tok / 250ms 的公式值 192，训练过的键上界 ~280，
// 故 192 原样显示；而一个远超上界的公式值必须被夹到上界。
{
	const key = { provider: "clamp", id: "model" };
	for (let i = 0; i < 6; i++) await stream(createInstance(true, key), clean(24));
	const small = await stream(createInstance(true, key), [[250, 50]]);
	expect(Math.abs(final(small)! - 192) < 2, `short reply within the bound is unchanged (${final(small)})`);
	await stream(createInstance(true, key), [[200, 1000]]);
	const big = await stream(createInstance(true, key), [[200, 1000]]);
	expect(peak(big)! < 600, `an absurd short-reply formula value is clamped to the bound (${peak(big)})`);
}

// 冷启动：无闸门时不夹紧，公式值原样（与既有行为一致）
{
	const shown = await stream(createInstance(true, { provider: "clamp", id: "cold" }), [[200, 1000]]);
	expect(peak(shown)! > 4000, `cold start does not clamp the formula value (${peak(shown)})`);
}
```

- [ ] **Step 10: 跑全部验证并提交**

Run:
```bash
node test-estimator.ts && node test-global.ts && node token-speed.ts && \
npx tsc --module nodenext --moduleResolution nodenext --target es2022 --strict --noEmit --skipLibCheck --types node token-speed.ts
```
Expected: `All checks passed.` + `All checks passed.` + 冒烟无输出 + tsc 退出码 0。

```bash
git add token-speed.ts test-estimator.ts
git commit -m "feat: gate live speed on the model's own history, clamp short replies

Adds an in-memory per-(provider, model) history ring that each response
feeds with HISTORY_SEGMENTS segment medians, so a single spike cannot move
the history while the ring still fills within a few responses. The derived
plausibility bound (median + 6 x max(1.4826 MAD, 0.3 median)) drops cycle
rates that are more likely arrival artifacts than real rates; when nothing
plausible remains the footer stays silent and keeps the last shown speed.

Cold start is deliberately unfiltered: an unknown model is never censored
on the basis of not having been seen before. A response too short to
measure still uses usage.output / elapsed, now clamped to the plausible
range so an absurd formula value (which includes prefill) cannot freeze on
the footer. The store stays on globalThis with the same field-wise
migration the rest of it uses, and there is no disk IO."
```

---

### Task 3: 粗粒度 provider 可测性（验证时间裁剪确已移除）

**Files:**
- Test: `test-estimator.ts`

**Interfaces:**
- Consumes: Task 1 的 `pushSample`（仅按数量裁剪）、`estimateStreamSpeed`。
- Produces: 无新接口（纯回归保护）。

- [ ] **Step 1: 写测试**

追加：

```ts
// 粗粒度 provider：delta 间隔 >= 300ms 时，既有实现的时间裁剪只留 3 个到达，
// 周期窗口永远凑不齐 -> footer 不显示任何速度。新规则必须能算出来。
for (const [gapMs, chunk] of [
	[300, 30],
	[1000, 100],
	[2000, 200],
] as Array<[number, number]>) {
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 6; i++) steps.push([gapMs, (acc += chunk)]);
	const shown = await stream(
		createInstance(true, { provider: "coarse", id: `gap-${gapMs}` }),
		steps,
	);
	const expected = (chunk / gapMs) * 1000;
	expect(
		final(shown) !== undefined && Math.abs(final(shown)! - expected) / expected < 0.2,
		`coarse ${gapMs}ms provider is measurable (final ${final(shown)}, expected ~${expected})`,
	);
}
```

- [ ] **Step 2: 运行测试**

Run: `node test-estimator.ts`
Expected: PASS（Task 1 已删除时间裁剪）。若 FAIL，说明时间裁剪仍在，回到 Task 1 Step 4。

- [ ] **Step 3: 提交**

```bash
git add test-estimator.ts
git commit -m "test: cover coarse-provider measurability

Regression guard for the removed time-based sample cutoff: a provider
emitting a delta every 300ms-2s must still produce a speed reading."
```

---

### Task 4: 文档与版本

**Files:**
- Modify: `README.md`（"速度估计算法"章节、新增可行域闸门与代价说明、开发命令加测试）
- Modify: `package.json`（version 1.4.0 → 1.5.0）
- Modify: `.github/workflows/ci.yml`（在功能回归后加估计器测试）

**Interfaces:**
- Consumes: 全部前序任务的最终行为。
- Produces: 无代码接口。

- [ ] **Step 1: 更新 README 的算法章节**

把 README 中"### 速度估计算法"整节替换为：

```md
### 速度估计算法

直接对"累计 token / 已用时间"求平均或做差都不行：provider 经常把大量 token 攒在一个 delta 里到达（首个大 chunk、整个工具调用参数 blob、代理缓冲），这一个批次会让朴素算法显示上千 tok/s，并且长时间缓慢衰减。

所以速度在**到达周期**上测量，并叠加一个由历史导出的可行域闸门：

1. **周期 = 相邻两个"带 token 的到达"之间**，周期速率 = `Δtoken / (t_end − t_start)`。零 token 的事件（role-only、`finish_reason`、usage-only、心跳）不构成周期，因此天然不会污染估计——既不会闪到 0，也不会因为丢弃它们而虚高。
2. 取最近 8 个周期速率。**窗口不足 5 个时取最小值**，5 个及以上取中位数。窗口小时必须保守：中位数只在离群值占少数时才有效，3 个周期里 2 个被污染就能带跑它（实测 2600 tok/s，而真实是 100）。
3. **可行域闸门**：按 (provider, model) 在内存中积累该模型的历史速率分布（32 样本环形缓冲，每个响应写入 4 个分段中位数）。边界为

   ```
   中位数 + 6 × max(1.4826 × MAD, 0.3 × 中位数)
   ```

   超出边界的周期速率视为到达伪影，不参与估计；若没有可信周期可用，则**静默**（继续显示上一次的速度）。用 MAD 而非标准差：实测 20% 样本为 20 倍 spike 时边界仅从 212 动到 230 tok/s。
4. **历史不足 12 样本（约 3 个响应）时闸门不启用**——没有依据就不做判断，未知模型绝不被压低。冷启动行为与旧实现一致。

这样还顺带解决了两个实际问题：

- **零 token 的 delta**：见第 1 条，不再需要特判。
- **流式间隔不均**：5ms 一个 delta 和 2s 一个 delta 都能得到正确速率，不需要知道 provider 的节奏。

代价（实测）：

- 如果模型的真实速率超过历史中位数约 2.8 倍（例如换到快得多的模型），会有最多约 **5 个响应**的"暂无新数字"期（继续显示上一次的速度），之后恢复正常。
- 持续粗粒度交付（例如代理批量转发）在积累足够历史后会被闸门识别并静默——这是"不再显示高于常理的读数"的必然代价，单靠时间规则无法区分"模型快"与"传输批量化"。
- 无历史时若窗口内污染占多数（8 个周期中 ≥4 个），中位数仍可能被带跑；这与旧实现是同一个极限，闸门在约 3 个响应后关闭该缺口。
- 整个响应只有一个 delta（例如 200ms 内结束的短回复）时，沿用 `usage.output / 耗时` 作为最终值，但已**夹紧到该模型的历史可行域**；无历史时不夹紧。

闸门与历史**只存内存**（挂在进程级共享 store 上，`/reload` 存活、进程退出即丢），**不写任何文件**。
```

- [ ] **Step 2: 更新 README 的开发命令**

在"## 开发"的代码块中，`node test-global.ts` 之前插入一行：

```bash
node test-estimator.ts  # 估计器回归：周期采样、可行域闸门、超短回复夹紧
```

- [ ] **Step 3: 更新 CI**

在 `.github/workflows/ci.yml` 的"功能回归测试"步骤之后插入：

```yaml
      # 估计器回归：虚拟时钟驱动，覆盖周期采样、历史闸门、超短回复夹紧
      - name: 估计器回归测试
        run: node test-estimator.ts
```

- [ ] **Step 4: 提升版本号**

`package.json` 的 `"version": "1.4.0"` 改为 `"version": "1.5.0"`。

- [ ] **Step 5: 验证打包内容**

Run: `npm pack --dry-run 2>&1 | tail -20`
Expected: 打包文件列表包含 `token-speed.ts`、`README.md`、`package.json`（`test-estimator.ts` 不进包，`files` 字段本就只列 `token-speed.ts`）。

- [ ] **Step 6: 提交**

```bash
git add README.md package.json .github/workflows/ci.yml
git commit -m "docs: document the cycle estimator, the history gate, and its costs

Rewrites the algorithm section around arrival cycles and the
history-derived plausibility bound, states the measured costs (up to ~5
silent responses after a genuine 2.8x speed-up, coarse-delivery
suppression, the cold-start majority-pollution gap), and adds the new
estimator regression to the dev commands and CI."
```

---

## Self-Review

**1. Spec coverage:**

| Spec 章节 | 实施任务 |
|---|---|
| §1 周期定义（替代墙钟桶） | Task 1 |
| §1 删除时间裁剪 | Task 1 Step 4 + Task 3（回归保护） |
| §2 实时取值（min / median） | Task 1 Step 4 |
| §2 冷启动残留缺口（记录、不修） | Task 4 Step 1（写入 README 代价） |
| §3 可行域闸门（键、样本写入、容量、公式、未启用条件、拒绝静默） | Task 2 |
| §3 用 MAD 不用标准差 | Task 2 Step 5 |
| §3 每响应写入用全部周期速率（非闸门子集） | Task 2 Step 5 |
| §4 超短回复夹紧到上界 | Task 2 Step 8 |
| §5 与既有逻辑的关系（不回退、TTFT、聚合、迁移） | 无改动；Task 1/2 的每步验证要求既有回归全绿 |
| 决策：仅内存、静默、夹紧、历史导出 | Task 2 |
| 测试计划 1/2/3/4（相邻肥 chunk、blob、flush、静默后 flush） | Task 1 Step 1（早期相邻肥 chunk）、Task 2 Step 1（训练后相邻肥 chunk）|
| 测试计划 5（不误伤真高速） | Task 2 Step 1（冷启动 2000）|
| 测试计划 6（诚实抖动不低估） | Task 2 Step 9 |
| 测试计划 7/8（冷启动不误伤 / 相对既有实现改进） | Task 1 Step 1、Task 2 Step 1 |
| 测试计划 9（超短回复夹紧） | Task 2 Step 9 |
| 测试计划 10（粗粒度可测） | Task 3 |
| 测试计划 11（无磁盘写入） | 由 Global Constraints 的"不得引入任何磁盘 IO"约束保证；实现中无 fs import，故无文件可写 |
| 代价写入 README | Task 4 Step 1 |

**2. Placeholder scan:** 无 TBD/TODO；每个代码步骤都给出了完整代码；无"类似 Task N"式引用（Task 3 的测试代码完整重复给出）。

**3. Type consistency:** `cycleRates(samples, keep)`（Task 1 定义 → Task 2 复用）、`estimateStreamSpeed(samples, gate?)`（Task 1 定义单参数版本、Task 2 Step 7 加第二参数并同步两个调用点）、`plausibilityBound(store, key)` 与 `rateKey(ctx)`（Task 2 Step 5 定义 → Task 2 Step 8 调用）、`recordResponseHistory(store, key, samples)`（Task 2 定义 → Task 2 Step 6 调用）均已核对一致。`Gate` / `SpeedHistory` 均在 Task 2 定义与使用，字段名 `median` / `bound` / `samples` / `next` 一致。

**任务切分说明：** 原计划的 Task 2（历史存储）与 Task 3（闸门接入）已合并为单个 Task 2，因此每个任务结束时全部检查均为绿色，`test-estimator.ts` 中不存在任何"已知失败"的中间状态。

**计划代码已验证：** 本计划中 Task 1–4 的实现代码与全部测试代码，已在一份临时副本上完整应用并跑通（13 项检查全绿、`test-global.ts` 33 项全绿、`node token-speed.ts` 冒烟通过、`tsc --strict` 无输出），随后已回退到原始 `token-speed.ts`，仓库保持干净。验证过程中修正了测试⾃身的三个缺陷，均已写回本计划的代码：

1. `setStatus` 解析必须**只取 MAIN 段**（首个 ` · ` 之前）——否则 subagent 聚合段（如 `6 sub · 300 tok/s`）会被误读成主会话速度。
2. `stream()` 末尾必须调 `session_shutdown` + `agent_end` 清理共享 store，否则残留会话会进入后续实例的聚合段。
3. 诚实抖动用例的 token 增量必须与 1000ms 间隔匹配（原写法实际产生 2500 tok/s 而非 125）。