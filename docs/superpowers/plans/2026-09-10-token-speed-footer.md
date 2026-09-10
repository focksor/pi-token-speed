# Pi Token Speed Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a standalone pi extension under `~/workSpace/pi-token-speed` that shows estimated output-token speed while an assistant response streams and the exact provider-reported output-token speed after the response completes.

**Architecture:** Use pi's extension lifecycle events rather than modifying pi core. `message_start` opens a timing window, `message_update` updates a throttled approximate count from the partial assistant message, and `message_end` replaces it with `message.usage.output` divided by elapsed response time. Use `ctx.ui.setStatus()` so the built-in footer remains intact.

**Tech Stack:** TypeScript extension loaded by pi/jiti, `@earendil-works/pi-coding-agent` extension types, pi-ai assistant message shapes, Node `performance.now()`.

## Global Constraints

- Do not modify pi's installed source or the existing `tiersync` repository.
- Keep the plugin dependency-free; pi resolves its built-in extension packages at runtime.
- Use `ctx.ui.setStatus("token-speed", ...)` so the value appears in pi's built-in footer.
- Prefer provider-reported `usage.output` for the completed value; label fallback streaming values as estimates.
- Clear the status when the extension session shuts down.
- Keep all rendered status text to one compact footer line.

---

### Task 1: Implement the standalone extension and usage documentation

**Files:**
- Create: `/home/focksor/workSpace/pi-token-speed/token-speed.ts`
- Create: `/home/focksor/workSpace/pi-token-speed/README.md`

**Interfaces:**
- Consumes: pi `message_start`, `message_update`, `message_end`, and `session_shutdown` extension events.
- Produces: the persistent footer status key `token-speed` and a command-line loadable extension file.

- [x] **Step 1: Implement timing and token estimation helpers**

Create `token-speed.ts` with:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

type SpeedState = {
  startedAt?: number;
  estimatedOutputTokens: number;
  completedOutputTokens?: number;
};

function estimateOutputTokens(message: AssistantMessage): number {
  let characters = 0;

  for (const part of message.content) {
    if (part.type === "text") {
      characters += part.text.length;
    } else if (part.type === "thinking") {
      characters += part.thinking.length;
    } else if (part.type === "toolCall") {
      characters += part.name.length;
      characters += JSON.stringify(part.arguments)?.length ?? 0;
    }
  }

  return Math.ceil(characters / 4);
}

function tokensPerSecond(tokens: number, startedAt: number): number {
  const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
  return tokens / elapsedSeconds;
}
```

- [x] **Step 2: Wire the extension lifecycle events**

Add a default extension factory that:

- Initializes `SpeedState` and a `lastRenderedAt` throttle timestamp.
- On assistant `message_start`, resets timing and shows `⚡ ... tok/s`.
- On assistant `message_update`, uses `message.usage.output` when positive, otherwise `estimateOutputTokens(message)`, and refreshes the status at most every 100 ms with `(估算)` for fallback values.
- On assistant `message_end`, uses the final `message.usage.output` when available and renders an unlabelled exact `⚡ N tok/s`; if the provider does not report output tokens, falls back to the same estimate and keeps the `(估算)` label.
- On `session_shutdown`, clears `token-speed`.

The extension must narrow assistant messages by `message.role === "assistant"` and must not throw when `JSON.stringify(part.arguments)` returns an unexpected empty value.

- [x] **Step 3: Document loading and behavior**

Write `README.md` with:

```md
# pi-token-speed

在 pi 的默认 footer 中显示 assistant 输出速度。

## 使用

临时加载：

```bash
pi -e ~/workSpace/pi-token-speed/token-speed.ts
```

长期加载：把下面路径加入 `~/.pi/agent/settings.json` 的 `extensions` 数组：

```json
{
  "extensions": [
    "/home/focksor/workSpace/pi-token-speed/token-speed.ts"
  ]
}
```

流式阶段显示的是基于字符数除以 4 的近似速度；响应完成后切换为 provider 返回的 `usage.output` 计算出的准确速度。速度口径包含从 assistant 响应开始到结束的总耗时，因此包含首 token 延迟。
```

- [x] **Step 4: Load-check the extension through pi**

Run:

```bash
pi --version
pi --help >/dev/null
pi -e /home/focksor/workSpace/pi-token-speed/token-speed.ts --help >/dev/null
```

Expected: all commands exit successfully and pi reports no extension-load error.

- [x] **Step 5: Inspect the created files**

Run:

```bash
find /home/focksor/workSpace/pi-token-speed -maxdepth 3 -type f -print | sort
```

Expected: exactly the extension, README, and the plan documentation are present; no generated build artifacts or credentials are created.

- [x] **Step 6: Final report**

Report the created paths, the temporary load command, the persistent settings option, and the fact that live values are estimated while completed values use provider usage.
