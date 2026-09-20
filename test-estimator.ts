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
}

// 冷启动不误伤：无历史的键下，真实 2000 tok/s 必须原样显示
{
	const shown = await stream(
		createInstance(true, { provider: "gate", id: "cold-fast" }),
		Array.from({ length: 30 }, (_, i) => [10, (i + 1) * 20] as [number, number]),
	);
	expect(final(shown)! > 1900, `cold start shows a genuine 2000 tok/s (final ${final(shown)})`);
}

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

performance.now = realNow;
if (failures > 0) {
	console.error(`\n${failures} check(s) failed.`);
	process.exit(1);
}
console.log("\nAll checks passed.");
