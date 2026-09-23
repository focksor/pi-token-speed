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
// message_end 定格的最终值是序列末尾的元素（直接 render + flush 会推两份）；
// 流式峰值必须排除末尾整个重复段——最终值现在是 TTFT 后全程平均，
// 可能（如实）高于流式期间的所有读数。
const streamPeak = (xs: Array<number | undefined>) => {
	const last = xs.at(-1);
	let end = xs.length;
	while (end > 0 && xs[end - 1] === last) end--;
	return peak(xs.slice(0, end));
};
const final = (xs: Array<number | undefined>) => xs.filter((x): x is number => x !== undefined).at(-1);

const clean = (n: number) => Array.from({ length: n }, (_, i) => [50, (i + 1) * 5] as [number, number]);

// [regression] 早期窗口被两个相邻肥 chunk 污染：既有实现显示 5100，新规则须为 100。
// 流式期间不得出现离谱读数；定格的最终值则是 TTFT 后全程平均——冷启动无闸门不夹紧，
// 肥 chunk 的 token 真实到达，均值如实包含它们（预期语义，非污染）：
// (24×5 + 2×500 − 首 arrival 5) / 1.16s ≈ 961。
{
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 24; i++) {
		acc += 5 + (i === 2 || i === 3 ? 500 : 0);
		steps.push([50, acc]);
	}
	const shown = await stream(createInstance(true, { provider: "p", id: "cold-early" }), steps);
	expect(
		streamPeak(shown)! <= 150,
		`early adjacent fat chunks stay near 100 while streaming (peak ${streamPeak(shown)})`,
	);
	expect(
		Math.abs(final(shown)! - (24 * 5 + 2 * 500 - 5) / 1.16) < 2,
		`final freezes to the post-TTFT average (${final(shown)} ≈ ${((24 * 5 + 2 * 500 - 5) / 1.16).toFixed(0)})`,
	);
}

// 稳态无污染：必须如实显示 100
{
	const shown = await stream(createInstance(true, { provider: "p", id: "cold-steady" }), clean(24));
	expect(peak(shown)! <= 101 && Math.abs(final(shown)! - 100) < 1, `steady 100 shows 100 (${shown.join(",")})`);
}

// ── 历史环与闸门（通过真实模块的可观察行为验证） ──────────────────────────
// 训练一个模型键：连续 4 个健康 ~100 tok/s 响应后，闸门应启用；此后一个
// 20 倍 spike 响应不得把显示推到 5100。
{
	const key = { provider: "gate", id: "model-train" };
	// 10 个健康响应写入 40 个样本，超过 HISTORY_CAP=32：自第 9 个响应起触发
	// 环形覆写分支（覆写并推进 next），同时验证覆写后的历史仍训练在 ~100。
	for (let i = 0; i < 10; i++) {
		await stream(createInstance(true, key), clean(24));
	}
	const healthy = await stream(createInstance(true, key), clean(24));
	expect(Math.abs(final(healthy)! - 100) < 1, `trained history still shows the true 100 (${final(healthy)})`);

	// MAJORITY pollution: 4 of 8 cycles carry a fat batch, so the median in
	// Task 1's own rule follows it and only the gate can suppress it. Verified:
	// without the gate this peaks at 5100, with it at 100. (A 2-cycle fat-chunk
	// spike is NOT a valid gate test — the cycle rule already handles it.)
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 24; i++) {
		acc += 5 + (i >= 8 && i <= 11 ? 500 : 0);
		steps.push([50, acc]);
	}
	const spiked = await stream(createInstance(true, key), steps);
	expect(peak(spiked)! <= 150, `trained gate suppresses majority pollution (peak ${peak(spiked)})`);
	// 平均值 (2115/1.16 ≈ 1823) 超出闸门上界 (~280)：定格值回退为流式估计，
	// 而不是把上界本身当作速度显示。
	expect(
		Math.abs(final(spiked)! - 100) < 2,
		`an above-bound average falls back to the streaming estimate, not the bound (final ${final(spiked)})`,
	);
}

// ── 交付粒度无关性：闸门必须能被“少 chunk”的 provider 训练 ────────────────
// 回归对象：HISTORY_MIN_CYCLES 曾等于 HISTORY_SEGMENTS * 2 = 8，于是每响应少于 8
// 个周期的 provider 永远写不进历史，闸门永不启用。网关攒批（代理转发）正是这种
// 交付形态，也是本扩展要活下来的场景。6 周期/响应下要触发历史写入分支，本项
// 在旧常量下必须失败（实测 peak 10100，真实 100）。
{
	const key = { provider: "granular", id: "coarse-delivery" };
	// 健康响应：6 个周期（7 个带 token 到达）@ 100 tok/s
	const shortHealthy = (i: number) => [50, (i + 1) * 5] as [number, number];
	for (let i = 0; i < 12; i++) {
		await stream(createInstance(true, key), Array.from({ length: 7 }, (_, i) => shortHealthy(i)));
	}
	// 同键、同交付粒度下遇 3/6 污染（半数）：只有闸门能抑制它
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 7; i++) {
		acc += 5 + (i >= 1 && i <= 3 ? 500 : 0);
		steps.push([50, acc]);
	}
	const spiked = await stream(createInstance(true, key), steps);
	expect(
		peak(spiked)! <= 150,
		`coarse-delivery provider can train the gate (peak ${peak(spiked)} vs true 100)`,
	);
	// 反向护栏：闸门被训练后，同键的诚实 100 不得被压或被抬
	const honest = await stream(
		createInstance(true, key),
		Array.from({ length: 25 }, (_, i) => [50, (i + 1) * 5] as [number, number]),
	);
	expect(
		final(honest)! >= 90 && final(honest)! <= 120,
		`and still reads the true 100 honestly (final ${final(honest)})`,
	);
}

// 冷启动早期污染：无历史时，前段 3/8 个周期被肥 chunk 污染。旧规则在 8 周期
// 窗口下用中位数，3 个污染周期不足以占多数但足以带跑早期窗口（实测 5100）。
// 本项在 SPEED_SMALL_WINDOW=5 下必须失败。
// 流式期间不得出现离谱读数；定格值为冷启动下如实的全程平均。
{
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 24; i++) {
		acc += 5 + (i >= 2 && i <= 4 ? 500 : 0);
		steps.push([50, acc]);
	}
	const shown = await stream(createInstance(true, { provider: "p", id: "cold-early-3" }), steps);
	expect(
		streamPeak(shown)! <= 150,
		`cold start survives 3/8 early pollution while streaming (peak ${streamPeak(shown)})`,
	);
	// 定格值 = 冷启动下如实显示的全程平均：(24×5 + 3×500 − 5)/1.16 ≈ 1392。
	expect(
		Math.abs(final(shown)! - (24 * 5 + 3 * 500 - 5) / 1.16) < 2,
		`final freezes to the honest post-TTFT average (${final(shown)})`,
	);
}

// 护栏：用“每个短响应都带一坨”的响应训练，不得把闸门抬高 —— 少数 spike 必须仍是少数。
// 本项有判别力：曾试验过“把 4 周期响应的相邻周期强行配对成 2 段”（每段 2 个周期），
// 配对会把 1 个 spike 和 1 个诚实周期混在一起，制出一个落在二者之间的污染样本，
// 实测闸门上界从 280 涨到 24839（等于不再设防）。改为逐周期分段后本项通过。
{
	const key = { provider: "granular", id: "poisoned-training" };
	for (let i = 0; i < 8; i++) {
		// 4 周期响应，仅 1 个周期带重 chunk（污染占少数），位置轮换以免永远落在同一段
		const spikeAt = 1 + (i % 3);
		const steps: Array<[number, number]> = [];
		let acc = 0;
		for (let j = 0; j < 5; j++) {
			acc += 5 + (j === spikeAt ? 500 : 0);
			steps.push([50, acc]);
		}
		await stream(createInstance(true, key), steps);
	}
	// 训练后闸门必须仍然“紧”：4/8 污染仍需被昂到 ~100
	const bad: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 25; i++) {
		acc += 5 + (i >= 8 && i <= 11 ? 500 : 0);
		bad.push([50, acc]);
	}
	const spiked = await stream(createInstance(true, key), bad);
	expect(peak(spiked)! <= 150, `minority spikes stay a minority in history (peak ${peak(spiked)})`);
	const honest = await stream(
		createInstance(true, key),
		Array.from({ length: 25 }, (_, i) => [50, (i + 1) * 5] as [number, number]),
	);
	expect(
		final(honest)! >= 90 && final(honest)! <= 120,
		`and honest 100 is not clipped by the trained gate (final ${final(honest)})`,
	);
}

// 冷启动不误伤：无历史的键下，真实 2000 tok/s 必须原样显示
{
	const shown = await stream(
		createInstance(true, { provider: "gate", id: "cold-fast" }),
		Array.from({ length: 30 }, (_, i) => [10, (i + 1) * 20] as [number, number]),
	);
	expect(final(shown)! > 1900, `cold start shows a genuine 2000 tok/s (final ${final(shown)})`);
}

// 诚实抖动不得被低估：周期速率交替 50/200（真实 125）显示须落在 [100,150]。
// 注意：本例用全新（冷启动）键，闸门不参与——它只验证估计器本身；闸门
// 不扭曲诚实抖动这一点已在预热键上单独验证。
//
// 流长须 ≥ 12 个周期（≥ 13 个带 token 到达）。取中位数要求窗口内离群值占少数，
// 而交替流的中位数取值取决于窗口长度的奇偶：窗口为奇数时 50 与 200 各占一半，
// 中位落在 200 一侧就稳定读 200。流只有 11 个周期时，任何 ≥12 的窗口都只能
// 看到这 11 个（奇数），于是读 200——那是窗口奇偶造成的，不是估计器偏差
// （实测：11 周期的流在 W=8/12/16/24/32 下分别读 125/200/200/200/200，
// 而 ≥ 12 周期时所有窗口都稳定读 125）。
{
	// 交替的周期速率为 50 与 200 tok/s、每段 1s：真实吞吐是 125 tok/s。
	// 因此 token 累计量须按每 1000ms 间隔增长 50/200。
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 20; i++) {
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

// 粗粒度 provider：一个被拉长的慢周期不得把估计值拖低。
// 时间裁剪的保留量只够 2 个周期时会退化为「窗口小时取 min」规则，于是单个慢周期
// 会直接决定显示值；仅按数量裁剪则保留 8 个周期，中位数把它丢弃。
// 判别性实测：无时间裁剪显示 100 全程；重新引入 1800ms 裁剪后中间出现 50。
{
	// 11 个周期：正常 700ms/70 token（100 tok/s），第 7 个周期放慢到 1400ms（50 tok/s）。
	const gaps = [700, 700, 700, 700, 700, 700, 700, 1400, 700, 700, 700, 700];
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (const gap of gaps) steps.push([gap, (acc += 70)]);
	const shown = await stream(createInstance(true, { provider: "coarse", id: "slow-cycle" }), steps);
	expect(
		shown.every((value) => value === undefined || value > 90),
		`one slow cycle does not drag the estimate down (${shown.map((v) => v?.toFixed(0) ?? "-").join(",")})`,
	);
}

// 覆盖性断言：粗粒度 provider（>=300ms 间隔）必须能算出速率。
// 注意本组本身**不具备判别力**——重新引入时间裁剪后它依然通过（裁剪仍保留
// 恰在 SPEED_MIN_CYCLES 下限的 2 个周期，因此照样报数）；判别力由上面的
// «one slow cycle» 断言承担。
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

// ── 首 token 突发：毫秒级周期不得穿透中位数 ───────────────────────────────
// 真实现场抓到的毛刺（用户实时 footer，冷启动、历史为空）：
//   ⚡ 81.7 tok/s · TTFT 19.8s…   →   ⚡ 49764 tok/s · TTFT 20.0s   →   ⚡ 121 tok/s
// 同一个 subagent 段也独立复现（31784 → 30836 → 237）。
//
// 机制（已用虚拟时钟精确复现 25050）：长 TTFT 后首 token 以背靠背 delta 到达，
// 5 个 delta（各 50 tok、间隔 1ms）产生 4 个 50000 tok/s 的周期。到第 8 个周期时
// 窗口是 [50000,50000,50000,50000, 98,100,100,100]——恰好 8 个，于是 min 规则
// （仅覆盖 <7）不生效，而非 7 个及以上用中位数：偶数样本时中位数退化为中间两个
// 的平均 (100+50000)/2 = 25050。
//
// 结构性根因：窗口按周期数计，4 个 1ms 周期在时间上只占 4ms，却与 50ms 正常
// 周期同权，污染因此恰占 50%——正中偶数中位数的最坏点。这也是为何单纯加宽
// 窗口治不了它（只改变污染占比，不改变同权事实）。
//
// 冷启动是关键条件：闸门需 3 个响应才能训练，所以首次响应必须自己能抗。
{
	// 20 秒的 TTFT，然后是 5 个 1ms 间隔的突发 delta（各 50 tok），再回到 100 tok/s。
	const steps: Array<[number, number]> = [];
	let acc = 0;
	steps.push([20000, (acc += 50)]);
	for (let i = 0; i < 4; i++) steps.push([1, (acc += 50)]);
	for (let i = 0; i < 40; i++) steps.push([50, (acc += 5)]);
	const shown = await stream(createInstance(true, { provider: "burst", id: "first-token" }), steps);
	const pk = streamPeak(shown)!;
	expect(
		pk <= 150,
		`first-token burst (5 deltas @1ms) cannot pierce the median while streaming (peak ${pk})`,
	);
	// 突发后实时值回到真实的 ~100；定格值则是 TTFT 后全程平均：(450−50)/2.014 ≈ 199 ——
	// 突发的 200 个 token 真实到达，均值如实包含它们（预期语义，非污染）。
	expect(
		Math.abs(final(shown)! - 400 / 2.014) < 2,
		`final freezes to the post-TTFT average including the burst (${final(shown)} ≈ ${(400 / 2.014).toFixed(0)})`,
	);
}

// 同一机制的更小突发（2 个 delta）：改动前不穿透，作为不得引入新回归的对照
{
	const steps: Array<[number, number]> = [];
	let acc = 0;
	steps.push([5000, (acc += 50)]);
	steps.push([1, (acc += 50)]);
	for (let i = 0; i < 40; i++) steps.push([50, (acc += 5)]);
	const shown = await stream(createInstance(true, { provider: "burst", id: "small" }), steps);
	expect(peak(shown)! <= 150, `a 2-delta burst stays clean (peak ${peak(shown)})`);
}

// 突发不只发生在 1ms：间隔越大毛刺越小但仍然显著（实测 2ms→12550、3ms→16667、
// 5ms→5050、10ms→2550、20ms→2500）。按“绝对时长”过滤只能覆盖 1ms，治不了这些；
// 逐周期时长加权才能全谱系抑制——本组断言卡住这一点。
for (const gapMs of [2, 5, 10]) {
	const steps: Array<[number, number]> = [];
	let acc = 0;
	steps.push([10000, (acc += 50)]);
	for (let i = 0; i < 5; i++) steps.push([gapMs, (acc += 50)]);
	for (let i = 0; i < 40; i++) steps.push([50, (acc += 5)]);
	const shown = await stream(
		createInstance(true, { provider: "burst", id: `gap-${gapMs}` }),
		steps,
	);
	expect(
		streamPeak(shown)! <= 150,
		`a 6-delta burst at ${gapMs}ms gaps stays clean while streaming (peak ${streamPeak(shown)})`,
	);
	// 定格值 = TTFT 后全程平均（含突发批次真实到达的 token，约 220）：预期语义。
	expect(
		final(shown)! > 180 && final(shown)! < 260,
		`final freezes to the honest post-TTFT average (${final(shown)})`,
	);
}

// ── 最终速度语义：尾部减速时定格全程平均，而非尾值 ──────────────────────
// 本优化的核心回归。长响应尾部减速（最后 8 个周期降到 20 tok/s）时，流式估计器
// 会停在 ~60（尾段慢周期占满半个窗口），旧实现把这个尾值定格；新实现定格为
// TTFT 后全程平均：(16×5 + 8×1 − 5)/1.16 ≈ 71.6 —— 与“这个响应到底多快”一致。
{
	const key = { provider: "final", id: "tail-stall" };
	// 预训练闸门：均值 71.6 远低于上界，走“直接显示平均值”的主路径
	for (let i = 0; i < 4; i++) await stream(createInstance(true, key), clean(24));
	const steps: Array<[number, number]> = [];
	let acc = 0;
	for (let i = 0; i < 24; i++) {
		acc += i < 16 ? 5 : 1;
		steps.push([50, acc]);
	}
	const shown = await stream(createInstance(true, key), steps);
	expect(
		Math.abs(final(shown)! - (16 * 5 + 8 * 1 - 5) / 1.16) < 2,
		`a decelerating tail freezes to the whole-response average, not the tail rate (${final(shown)} ≈ ${((16 * 5 + 8 * 1 - 5) / 1.16).toFixed(1)})`,
	);
}

// 平滑度：真实抖动的流不得让显示剧烈础動。
// 回归对象：SPEED_WINDOW 曾被调到 8，于是每周期 token 数在 3–8 波动、间隔在
// 45–80ms 波动时，显示会在约 60 tok/s 的范围内摆动、最大偏离真值约 38%（实测均值）。
// 平滑度只能靠窗口宽度换取，抗毛刺靠中位数——两者不可互相替代，所以本项与
// 上面的污染断言必须同时成立。
// 判别性（多 seed 均值，实测）：W=4→不稳定，W=8→59.6（本断言失败），
// W=12→44.0，W=16→35.4（通过）。
// 注：单个 seed 的范围方差极大（W=8 时实测跨 38–73），因此必须多 seed 取均值，
// 否则断言会随机飘动（见下方 6 个 seed）。
{
	const ranges: number[] = [];
	const drifts: number[] = [];
	for (let seedIndex = 1; seedIndex <= 6; seedIndex++) {
		// 均匀分布的伪随机（LCG），tok 3–8、dt 45–80ms：真实速率因 seed 而异，
		// 所以每次都比对“该次流自身的真实速率”，而不是写死一个期望值。
		let seed = (seedIndex * 2654435761) >>> 0;
		const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 4294967296);
		const steps: Array<[number, number]> = [];
		let acc = 0;
		let elapsedMs = 0;
		for (let i = 0; i < 90; i++) {
			acc += 3 + Math.floor(rand() * 6);
			const dt = 45 + Math.floor(rand() * 36);
			elapsedMs += dt;
			steps.push([dt, acc]);
		}
		const trueRate = (acc / elapsedMs) * 1000;
		const shown = await stream(
			createInstance(true, { provider: "smooth", id: `jittery-${seedIndex}` }),
			steps,
		);
		const stable = shown.filter((v): v is number => v !== undefined).slice(3); // 去掉热身
		ranges.push(Math.max(...stable) - Math.min(...stable));
		drifts.push(Math.max(...stable.map((v) => Math.abs(v - trueRate) / trueRate)));
	}
	const meanRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
	const meanDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
	expect(
		meanRange <= 45,
		`honest jitter stays smooth (mean swing ${meanRange.toFixed(0)} tok/s over ${ranges.length} seeds)`,
	);
	expect(
		meanDrift <= 0.3,
		`and never drifts far from the true rate (mean worst ${(meanDrift * 100).toFixed(0)}%)`,
	);
}

performance.now = realNow;
if (failures > 0) {
	console.error(`\n${failures} check(s) failed.`);
	process.exit(1);
}
console.log("\nAll checks passed.");
