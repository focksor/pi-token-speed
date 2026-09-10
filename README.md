# @focksor/pi-token-speed

在 pi 的默认 footer 中显示 assistant 输出速度。

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
