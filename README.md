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
- 流式速度在**到达周期**上测量，并经由历史导出的可行域闸门过滤（见下），响应完成后沿用同一个估计器，因此读到的数字在收尾时不会跳变（历史不足 12 样本时不启用）。
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

直接对"累计 token / 已用时间"求平均或做差都不行：provider 经常把大量 token 攒在一个 delta 里到达（首个大 chunk、整个工具调用参数 blob、代理缓冲），这一个批次会让朴素算法显示上千 tok/s，并且长时间缓慢衰减。

所以速度在**到达周期**上测量，并叠加一个由历史导出的可行域闸门：

1. **周期 = 相邻两个"带 token 的到达"之间**，周期速率 = `Δtoken / (t_end − t_start)`。零 token 的事件（role-only、`finish_reason`、usage-only、心跳）不构成周期，因此天然不会污染估计——既不会闪到 0，也不会因为丢弃它们而虚高。
2. 取最近 8 个周期速率。**窗口不足 5 个时取最小值**，5 个及以上取中位数。窗口小时必须保守：中位数只在离群值占少数时才有效，3 个周期里 2 个被污染就能带跑它（实测 2600 tok/s，而真实是 100）。
3. **可行域闸门**：按 (provider, model) 在内存中积累该模型的历史速率分布（32 样本环形缓冲，每个响应写入 4 个分段中位数）。边界为

   ```
   中位数 + 6 × max(1.4826 × MAD, 0.3 × 中位数)
   ```

   超出边界的周期速率视为到达伪影，不参与估计；若没有可信周期可用，则**静默**（继续显示上一次的速度）。用 MAD 而非标准差：实测 20% 样本为 20 倍 spike 时边界仅从 212 动到 230 tok/s。
4. **历史不足 12 样本（约 3 个响应）时闸门不启用**——没有依据就不做判断，未知模型绝不被压低、不做夹紧。注意"不启用"只指不做剔除与夹紧，不等于显示序列与旧实现完全相同：周期规则本身仍然生效，且在"响应早期 + 少数肥 chunk"这类场景下优于旧实现（实测旧实现显示 5100，新规则显示 100）。

这样还顺带解决了两个实际问题：

- **零 token 的 delta**：见第 1 条，不再需要特判。
- **流式间隔不均**：5ms 一个 delta 和 2s 一个 delta 都能得到正确速率，不需要知道 provider 的节奏。

代价（实测）：

- 如果模型的真实速率超过历史中位数约 2.8 倍（例如换到快得多的模型），会有最多约 **5 个响应**的"暂无新数字"期（继续显示上一次的速度），之后恢复正常。
- 持续粗粒度交付（例如代理批量转发）**不会**被永久静默：闸门无法区分"模型快"与"传输批量化"，因此**均匀**的批量交付会被历史吸收（显示该速率）；只有**高于**该模型历史分布的交付会先静默、并在约 5 个响应后随历史适应而恢复显示。这是"不再显示高于常理的读数"的代价，单靠时间规则无法还原真实速率。
- 一个响应只有包含至少 8 个周期（9 个带 token 到达）才会写入历史；更短的响应只是不参与历史积累。
- 无历史时若窗口内污染占多数（8 个周期中 ≥4 个），中位数仍可能被带跑；这与旧实现是同一个极限，闸门在约 3 个响应后关闭该缺口。
- 整个响应只有一个 delta（例如 200ms 内结束的短回复）时，沿用 `usage.output / 耗时` 作为最终值，但已**夹紧到该模型的历史可行域**；无历史时不夹紧。

闸门与历史**只存内存**（挂在进程级共享 store 上，`/reload` 存活、进程退出即丢），**不写任何文件**。

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
node test-estimator.ts    # 估计器回归：周期采样、可行域闸门、超短回复夹紧
node test-global.ts    # 多会话全局速度功能测试
node demo-timeline.ts  # footer 时间轴演示（真实时序，双响应衔接预览）
npx tsc --module nodenext --moduleResolution nodenext --target es2022 \
  --strict --noEmit --skipLibCheck --types node token-speed.ts
```
