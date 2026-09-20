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
