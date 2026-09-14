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
- 响应完成后：优先使用 provider 返回的 `usage.output`，计算准确的输出速度。
- 速度公式为 `output tokens / assistant 响应总耗时（秒）`，因此包含 TTFT。
- TTFT（Time To First Token，首字延迟）从 provider 请求发出（`before_provider_request`）计到收到首个流式内容（首次 `message_update`），小于 1 秒显示毫秒，否则显示秒。

示例：

```text
⚡ 32.4 tok/s · TTFT 830ms
```

## 全局速度（subagent 聚合）

pi-subagents 把每个 subagent 作为同进程内的独立会话运行，且子会话拿到的是 no-op UI（`ctx.ui.setStatus` 无效），所以 subagent 的速度默认无法到达主 footer。本扩展的做法是：每个会话的扩展实例都把自身流式状态上报到一个进程级共享 store（`globalThis`），由唯一拥有真实 UI 的主会话实例聚合渲染。

显示规则：

- 标签跟随**执行中**的 agent 数量（从 spawn 到 `agent_end`），在它们的流式间隙（工具执行、思考）保持稳定，不会在名字和数量之间翻转。
- **速度始终显示**（与主会话同规则）：每个 agent 有当前流式速度就显示当前值，没有（工具/思考间隙、热身期）就显示它最后一次测得的真实速度；聚合为各 agent 当前值或最后值的和。仅当 agent 从没测出过速度（刚 spawn 还在热身）时才退化为裸数量：

  ```text
  ⚡ 32.4 tok/s · TTFT 830ms · 3 sub · 45.2 tok/s   ← 主会话流式 + 3 个 agent
  ⚡ 28.1 tok/s · TTFT 620ms · 3 sub · 45.2 tok/s   ← agent 全部在跑工具/思考：保留最后速度
  ⚡ 3 sub                                          ← 全部刚启动还未测出速度（±1s 热身期）
  ```

- 主会话自己的速度信息**始终显示**：流式时实时速度+TTFT，空闲时保留最近一次的最终速度；聚合段只是追加在后，不会取代它。新会话还没跑过任何主消息时才可能只显示聚合段。
- 只剩 1 个 agent 时显示会话名（去掉 pi-subagents 的 `#id` 后缀、超长截断）：`⚡ 28.1 tok/s · TTFT 620ms · sub Explore · 18.0 tok/s`
- 响应前 1 秒为热身期，速度不计（避免首个大 chunk 除以近乎为 0 的时间产生上千 tok/s 的毛刺）；主会话同样在热身期显示 `...` 占位符。
- agent 结束（`agent_end`）后其速度与数量一并移除；会话被丢弃（约 10 分钟后）时自动清理，异常退出的残留由 5 分钟 TTL 兑底。

已知限制：

- 仅覆盖同进程会话：`isolated: true` 或 `extensions: false` 的 agent 类型不会加载本扩展、无法上报；独立 pi 进程（另开的终端、`pi -p` 一次性任务、`--mode json` 子进程）互相不可见。
- 聚合段不显示各 subagent 的 TTFT；逐 agent 的明细可看 pi-subagents 的 widget / FleetView。

## 开发

```bash
node token-speed.ts    # 加载冒烟（pi 导入均为 type-only）
node test-global.ts    # 多会话全局速度功能测试
npx tsc --module nodenext --moduleResolution nodenext --target es2022 \
  --strict --noEmit --skipLibCheck --types node token-speed.ts
```
