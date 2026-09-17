# @focksor/pi-token-speed

在 pi 的默认 footer 中显示 assistant 输出速度；运行 subagent（如 [pi-subagents](https://github.com/tintinweb/pi-subagents)）时，footer 会实时显示所有正在流式的 subagent 的聚合速度。

![npm](https://img.shields.io/npm/v/@focksor/pi-token-speed)

## 使用

从 npm 安装（推荐）：

```bash
pi install npm:@focksor/pi-token-speed
```

临时从源码加载：

```bash
pi -e ~/workSpace/pi-token-speed/token-speed.ts
```

本地开发长期加载：把下面路径加入 `~/.pi/agent/settings.json` 的 `extensions` 数组：

```json
{
  "extensions": [
    "/home/focksor/workSpace/pi-token-speed/token-speed.ts"
  ]
}
```

修改配置后重新启动 pi；已经运行的 pi 可以使用 `/reload` 重新加载扩展。

## 显示口径

- 响应生成中：footer 每约 100ms 刷新一次，使用当前文本、思考内容和工具调用参数的字符数除以 4 估算 token 数。
- 流式速度使用**弹性分桶中位数**（见下），响应完成后沿用同一个估计器，因此读到的数字在收尾时不会跳变。
- TTFT 不计入速度：这是“已产出 token / 产出耗时”的瞬时速率，不含首字延迟。
- TTFT（Time To First Token，首字延迟）从 provider 请求发出（`before_provider_request`）计到收到首个流式内容（首次 `message_update`），小于 1 秒显示毫秒，否则显示秒。
- 请求发出后、首个流式内容到达前，footer 实时刷新等待计时（约 10Hz），锚点与最终 TTFT 相同，等待中的数字会精确收敛到定格值；尾部的 `…` 表示仍在等待，首个 token 到达后计时停止并定格为最终 TTFT。
- 速度不回退：一次会话中只要显示过一次真实速度，之后的等待期和“样本不足”期都继续显示最近一次测得/最终的速度，不再退回 `...` 占位；`⚡ ... tok/s` 只出现在从未显示过速度的新会话：

  ```text
  ⚡ 32.4 tok/s · TTFT 2.4s…   ← 已显示过速度：等待期保留上次速度
  ⚡ ... tok/s · TTFT 2.4s…    ← 从未显示过速度的新会话
  ```

示例：

```text
⚡ 32.4 tok/s · TTFT 830ms
```

### 速度估计算法

直接对“累计 token / 已用时间”求平均或做差都不行：provider 经常把大量 token 攒在一个 delta 里到达（首个大 chunk、整个工具调用参数 blob、代理缓冲），这一个批次会让朴素算法显示上千 tok/s，并且长时间缓慢衰减。

所以速度取**最近几个桶速率的中位数**：

1. 把连续的流式区间合并成桶，桶宽随响应年龄收缩：`bucketMs = clamp(已用时间 / 3, 60ms, 200ms)`。响应很长时等价于约 1 秒的平滑窗口；响应只有两三百毫秒时也能凑出足够的桶。
2. 取最近 5 个桶速率的中位数。中位数天然丢弃离群值，一次大 chunk 只是五个桶里的一个。
3. 只有 2 个桶时加护栏：两者相差超过 2.5 倍则取较小者（批量/缓冲只会抬高区间速率，低值更可信）。

这样还顺带解决了两个实际问题：

- **零 token 的 delta**：role-only、`finish_reason`、usage-only、心跳等事件不含新 token。把它们当作速率 0 的区间，画面会时不时闪到 0；直接丢弃它们，又会因为区间被缩短而虚高 2–5 倍。分桶让它们只稀释所在桶，两者都不会发生。
- **流式间隔不均**：5ms 一个 delta 和 250ms 一个 delta 都能得到同一个正确速率，不需要知道 provider 的节奏。

代价：首个速度值要等到约 200ms（积累到 2 个桶）才出现，在此之前显示上一次的速度（从未显示过则为 `...`）。如果**整个响应只有一个 delta**（例如 200ms 内结束的短回复），物理上无法从单个区间区分“平稳 150 tok/s”和“一个 600 token 的突发”，此时沿用上一次的速度；这类情况下的最终值回退为 `usage.output / 耗时`。

## 全局速度（subagent 聚合）

pi-subagents 把每个 subagent 作为同进程内的独立会话运行，且子会话拿到的是 no-op UI（`ctx.ui.setStatus` 无效），所以 subagent 的速度默认无法到达主 footer。本扩展的做法是：每个会话的扩展实例都把自身流式状态上报到一个进程级共享 store（`globalThis`），由唯一拥有真实 UI 的主会话实例聚合渲染。

显示规则：

- 标签跟随**执行中**的 agent 数量（从 spawn 到 `agent_end`），在它们的流式间隙（工具执行、思考）保持稳定，不会在名字和数量之间翻转。
- **速度始终显示**（与主会话同规则）：每个 agent 有当前流式速度就显示当前值，停止流式后短时间内继续显示它最后一次测得的速度；聚合为各 agent 当前值或（3 秒内的）最后值之和。这个 3 秒时效是必要的——否则一个结束了大输出、进入长工具阶段的 agent 会把它冻结的速度一直加进总和，让聚合值长期虚高：

  ```text
  ⚡ 32.4 tok/s · TTFT 830ms · 3 sub · 45.2 tok/s   ← 主会话流式 + 3 个 agent
  ⚡ 28.1 tok/s · TTFT 620ms · 3 sub · 45.2 tok/s   ← agent 全部在跑工具/思考：保留最后速度
  ⚡ 3 sub                                          ← 全部刚启动 / 最后速度已过期（样本不足期）
  ```

- 主会话自己的速度信息**始终显示**：流式时实时速度+TTFT，空闲时保留最近一次的最终速度；聚合段只是追加在后，不会取代它。新会话还没跑过任何主消息时才可能只显示聚合段。
- 只剩 1 个 agent 时显示会话名（去掉 pi-subagents 的 `#id` 后缀、超长截断）：`⚡ 28.1 tok/s · TTFT 620ms · sub Explore · 18.0 tok/s`
- agent 结束（`agent_end`）后其速度与数量一并移除；会话被丢弃（约 10 分钟后）时自动清理，异常退出的残留由 5 分钟 TTL 兜底。

已知限制：

- 仅覆盖同进程会话：`isolated: true` 或 `extensions: false` 的 agent 类型不会加载本扩展、无法上报；独立 pi 进程（另开的终端、`pi -p` 一次性任务、`--mode json` 子进程）互相不可见。
- 聚合段不显示各 subagent 的 TTFT；逐 agent 的明细可看 pi-subagents 的 widget / FleetView。

## 开发

```bash
node token-speed.ts    # 加载冒烟（pi 导入均为 type-only）
node test-global.ts    # 多会话全局速度功能测试
node demo-timeline.ts  # footer 时间轴演示（真实时序，双响应衔接预览）
npx tsc --module nodenext --moduleResolution nodenext --target es2022 \
  --strict --noEmit --skipLibCheck --types node token-speed.ts
```
