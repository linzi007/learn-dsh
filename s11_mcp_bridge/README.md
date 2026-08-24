# 11：MCP bridge——把外部工具接进 ToolRuntime

> 一句话目标：用真实 `@deepseek-ai/dsh-mcp-client` 连接本章自写的 **local fixture MCP stdio server**，观察 tool discovery、raw/public name、参数错误与 tool-result 失败边界，以及 Plugin Fiber dispose 后的工具和子进程清理。

> **Fixture 声明：**[`src/local-fixture-server.ts`](src/local-fixture-server.ts) 是课程原创、确定性业务逻辑的 local fixture；它使用官方 MCP SDK、运行在独立子进程并走真实 MCP JSON-RPC/stdio 协议，但不是生产 MCP 服务，也没有引用上游测试 fixture。

- 上一章：[10 Compaction](../s10_compaction/)
- API Key：不需要
- 本章核心增量：把一个进程外 MCP server 发现的 tools 映射成 DSH 原生工具，并把连接生命周期交给 Plugin Fiber
- 下一章：[12 Subagent 与 Workflow](../s12_subagent_workflow/)

## 问题

S05 已经能在同一进程注册 `course_add`，S06 又让 AgentLoop 完成了一次工具往返。但真实工具生态经常不和 Agent Harness 写在同一个进程、同一种语言或同一个仓库里。

MCP（Model Context Protocol）解决的是连接契约：server 对外声明 tools，client 通过协议发现并调用。接入 Harness 时还要回答几件更具体的事：

1. MCP server 的 raw tool name 怎样避免和其他 server 冲突？
2. 模型看见的名字，是否就是 `tools/call` 发到 server 的名字？
3. server 给出的 `inputSchema` 在哪一侧执行参数验证？
4. MCP `isError: true` 怎样变成 Harness 可观察的失败？
5. Plugin 卸载后，ToolRuntime registration 和 stdio child process 谁来清理？

本章用两个确定性 fixture tools 回答这些问题：

| raw MCP tool | public DSH tool | 行为 |
| --- | --- | --- |
| `course_lookup` | `mcp__course_fixture__course_lookup` | 查询 `plugin / effect / fiber`，返回 raw name、调用次数和 child PID |
| `course_fail` | `mcp__course_fixture__course_fail` | 确定性返回 MCP `isError: true` |

这里不接 LLM。S06 已经证明模型可以经 ToolRuntime 调工具，本章只增加 MCP bridge；直接调用 `ctx.tools.execute()` 能更清楚地观察名字、参数、协议和生命周期边界。

## 先认识九个基本概念

### 1. MCP Host、Client 与 Server 不是同一个角色

在本章里：

- Learn DSH 进程是 Host，持有 Cordis `Context`、`ToolRuntime` 和 Plugin Fiber；
- `@deepseek-ai/dsh-mcp-client` 是 MCP Client bridge；
- `local-fixture-server.ts` 是 MCP Server，运行在另一个 Node.js 子进程；
- `StdioClientTransport` / `StdioServerTransport` 用 stdin/stdout 承载 MCP JSON-RPC 消息。

```text
Host / learn-dsh process
  └─ dsh-mcp-client
       └─ stdio transport
            └─ child process / local fixture MCP server
```

MCP 不是 AgentLoop，也不是 ToolRuntime 的替代品。它让外部 server 的能力跨过进程边界；进入 Host 后，工具仍由真实 `ctx.tools` 负责呈现和执行。

### 2. `initialize`、`tools/list` 与 `tools/call`

连接建立后，MCP Client 与 Server 先完成 `initialize` 协商。随后 bridge 请求 `tools/list`，拿到每个 tool 的 raw name、description 与 `inputSchema`。

真正执行时才发送：

```text
tools/call {
  name: "course_lookup",
  arguments: { concept: "plugin" }
}
```

本章没有手写 JSON-RPC parser，也没有伪造 `listTools()` 返回值。父进程和子进程都使用官方 MCP SDK，discovery 与 call 都经过真实 stdio transport。

### 3. raw name 与 public name 属于两个边界

MCP Server 声明的名字叫 raw name，例如：

```text
course_lookup
```

如果两个 server 都发布 `search`，直接注册到一个全局 ToolRuntime 会冲突。因此 bridge 使用配置的 `serverName` 生成模型可见 public name。本章的 `serverName` 与 raw name 都是合法且较短的 safe-name clean case，所以结果正好是：

```text
mcp__<serverName>__<rawName>
mcp__course_fixture__course_lookup
```

下文把这条 clean-case 形式写作 `mcp__<serverName>__<rawName>`。固定上游遇到非法字符或超长名称时会 normalize 并附加 hash；因此 public name 不是可以在运行时反向解析的 wire identity。

两个名字不能混用：

| 名字 | 存在位置 | 本章结果 |
| --- | --- | --- |
| `course_lookup` | MCP server / `tools/call` wire | 不注册到 `ctx.tools` |
| `mcp__course_fixture__course_lookup` | DSH Registry / model-facing schema | 调用 bridge 的入口 |

bridge 在创建 Tool Definition 时闭包保存 raw name，不会在执行时从 public name 反向猜测它。实验用 public name 发起调用，而 handler 返回 `rawToolName: "course_lookup"`；直接把 raw name 交给 ToolRuntime 则得到 `UNKNOWN_TOOL`。

### 4. `serverName` 是本地 namespace，不是远端身份认证

本章配置：

```ts
{
  transport: 'stdio',
  serverName: 'course_fixture',
  command: process.execPath,
  args: [fixtureServerPath],
}
```

`serverName` 决定 public tool prefix，并要求同一个 root 上的 live MCP clients 不重复。它不是 server 签名、租户 id、权限 token 或网络认证。

真实部署仍要独立判断 command 来源、HTTP URL、headers、环境变量、server 软件供应链和它能访问的本机资源。一个名字叫 `trusted` 的 server 不会因此变得可信。

### 5. MCP tool schema 先用于 discovery 与模型呈现

fixture 通过官方 SDK 注册：

```ts
server.registerTool('course_lookup', {
  description: '从确定性课程 fixture 查询一个 lifecycle 概念。',
  inputSchema: {
    concept: z.enum(['plugin', 'effect', 'fiber']),
  },
}, handler)
```

bridge 将 server 返回的 JSON Schema 放进 DSH `ToolDefinition.parameters`。因此 `ctx.tools.schemas()` 与后续 System Prompt assembly 可以向模型展示同一份输入契约。

但“schema 出现在 Tool Definition 上”不自动等于“ToolRuntime 会替所有第三方 definition 执行参数验证”。S05 的 `defineTool()` 会生成自带本地 `validateArgs` wrapper 的 definition；MCP bridge 创建的是直接转发到 server 的 raw `ToolDefinition`。

### 6. 本章参数错误由 MCP Server SDK 拒绝

本章先调用：

```ts
ctx.tools.execute({
  name: 'mcp__course_fixture__course_lookup',
  arguments: { concept: 'unknown' },
  // ...
})
```

请求会跨过 bridge。MCP Server SDK 在进入课程 handler 前按 `inputSchema` 拒绝它，并返回 JSON-RPC invalid params：

```text
MCP error -32602: Input validation error
```

这里的错误家族标识是 `MCP error -32602`。

所以这里不会出现 S05 的 DSH `INVALID_ARGS` code。这不是 handler 成功执行：fixture 只在 handler 内增加 `lookupCalls`，下一次首次有效查询仍返回 `callCount: 1`。

这条边界很重要：

- model-facing schema：帮助模型构造参数；
- bridge：把调用转成 MCP request；
- MCP Server SDK：在 handler 前执行本章的实际参数校验；
- handler：只接收已经通过 server schema 的参数。

### 7. canonical `McpResult` 与 model-facing `content`

成功的 MCP call 返回完整 canonical value：

其中 `structuredContent` 保存 server 给程序化调用方的结构化结果：

```ts
{
  content: [
    { type: 'text', text: '[local fixture] plugin: ...' },
  ],
  structuredContent: {
    rawToolName: 'course_lookup',
    concept: 'plugin',
    fixture: true,
    callCount: 1,
    serverPid: 12345,
    explanation: '...',
  },
}
```

这份值保留在成功 `ToolExecutionResult.value` 中，供程序化调用者读取。ToolRuntime 还通过 bridge 的 output renderer 生成 `ToolExecutionResult.content`，供 Native 模型上下文展示。

本章只返回 text block。MCP Client 还对 image、resource link、audio 等 block 有更细的持久化或诊断规则，但那会引入 attachment store 与模型 route capability，不属于本章唯一增量。

### 8. MCP `isError` 与 DSH error code 不是一回事

`course_fail` handler 正常响应 MCP request，但结果明确携带：

```ts
{
  content: [{ type: 'text', text: '[local fixture] rejected: ...' }],
  isError: true,
}
```

bridge 看到 MCP `isError: true` 后抛出带该文本的普通 `Error`，ToolRuntime 将它规范化成：

```text
ToolExecutionResult.isError = true
error.message = "[local fixture] rejected: ..."
```

它没有伪装成 `INVALID_ARGS`、`UNKNOWN_TOOL` 或其他 DSH `HarnessError` code，所以 `error.info` 没有对应 code。调用方应该先看 `isError` 和 message，再只对真实存在的稳定 code 做路由。

### 9. Plugin Fiber 同时拥有 registration 与 connection

bridge 以 namespace plugin 形式挂载：

```ts
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

const bridgeFiber = root.plugin(McpClient, config)
await bridgeFiber.await()
```

`await()` 返回时，首次 connect、`tools/list` 与 registration 已完成。Effect 是登记在 owning Fiber 上、dispose 时会调用 disposer 的资源单元；这个 Fiber 的 Effects 持有：

- `serverName` reservation；
- MCP client / stdio transport / child process connection；
- 当前 discovery generation 的 tool registration disposers；
- reconnect state（本章为缩小实验显式关闭）。

真正触发生命周期清理的公开调用是 `bridgeFiber.dispose()`，不是手动注销某一个 tool。

调用 `await bridgeFiber.dispose()` 后，本章从三个方向验证清理：

1. `ctx.tools.schemas()` 不再包含两个 MCP public tools；
2. 再次执行 public name 得到 `UNKNOWN_TOOL`；
3. 用成功结果里的 child PID 做 signal-0 probe，确认 local fixture process 已停止。

dispose 是资源所有权边界，不只是“从模型提示词里隐藏名字”。

## 你会交付什么

本章交付一条完全 keyless 的真实协议实验：

1. 独立 child process 启动原创 local fixture MCP stdio server；
2. 真实 bridge 完成 initialize、discovery，并注册两个 server-qualified tools；
3. raw name 直调得到 `UNKNOWN_TOOL`；
4. 错误 enum 由 MCP Server SDK 以 `-32602` 拒绝，且 handler 没有执行；
5. public name 成功命中 raw handler，并保留 canonical MCP blocks 与 structured content；
6. MCP `isError` 进入 ToolRuntime failure；
7. bridge Plugin Fiber dispose 注销 tools 并停止子进程。

文件分工：

- [`src/fixture-contract.ts`](src/fixture-contract.ts)：父进程与子进程共享的纯静态 raw names，没有启动副作用；
- [`src/local-fixture-server.ts`](src/local-fixture-server.ts)：官方 SDK 驱动的真实 MCP stdio server executable，业务逻辑明确标注为 local fixture；
- [`src/mcp-bridge-lab.ts`](src/mcp-bridge-lab.ts)：真实 Cordis / ToolRuntime / MCP Client composition 与完整场景；
- [`src/demo.ts`](src/demo.ts)：四组 `node:assert/strict` PASS；
- [`tests/mcp-bridge.test.ts`](tests/mcp-bridge.test.ts)：discovery、name、参数、protocol error 与 lifecycle 行为验收；
- [`tests/chapter-contract.test.ts`](tests/chapter-contract.test.ts)：教学结构、固定依赖、fixture 边界和公开 API 门禁。

## 机制图

```text
learn-dsh parent process
│
├─ Context
│   ├─ SystemPrompt
│   ├─ ToolRuntime
│   └─ MCP Client Plugin Fiber
│       │
│       ├─ tools/list
│       │    raw: course_lookup
│       │      └─ register public:
│       │         mcp__course_fixture__course_lookup
│       │
│       └─ tools/call
│            public name selects ToolDefinition
│            closed-over raw name = course_lookup
│            arguments = { concept: "plugin" }
│                       │
│                 real stdio / MCP JSON-RPC
│                       │
└───────────────────────v────────────────────────
                 child Node.js process
                 McpServer + StdioServerTransport
                       │
                       ├─ SDK validates inputSchema
                       └─ local fixture handler
                              └─ MCP content + structuredContent
```

dispose 路径：

```text
bridgeFiber.dispose()
  ├─ stop reconnect state
  ├─ close MCP client / stdio transport
  │    └─ stop child fixture process
  ├─ unregister current tool generation
  └─ release serverName reservation

ctx.tools.execute(public name after dispose)
  └─ UNKNOWN_TOOL
```

## 本章边界

真实部分：

- `@deepseek-ai/cordis@4.0.1` 的真实 Context、Plugin Fiber 与 Effects；
- `@deepseek-ai/dsh-tools@0.1.1-rc.2` 的真实 ToolRuntime；
- `@deepseek-ai/dsh-mcp-client@0.1.1-rc.2` 的公开 namespace plugin；
- `@modelcontextprotocol/sdk@1.29.0` 的真实 MCP Client/Server transport 与 JSON-RPC；
- 独立 stdio child process、真实 discovery、call 与 shutdown。

教学 fixture 部分：

- `plugin / effect / fiber` 三条固定说明；
- `lookupCalls` 进程内计数器；
- `course_fail` 的确定性 `isError`；
- 用 child PID 做的 macOS/Linux lifecycle probe。

本章有意不进入：

- 真实 LLM 与 AgentLoop；
- Streamable HTTP、SSE、remote server 与 OAuth；
- MCP Resources、Prompts、sampling、elicitation 或 experimental tasks；
- tool list change、re-sync、crash recovery 与 reconnect backoff；
- image / audio / embedded resource 的 durable projection；
- server 软件供应链审计、OS sandbox、网络隔离与 secret 管理；
- 多 server namespace conflict 与长 raw name normalization；
- 生产级 observability、health check 与 process supervisor。

**真实 MCP protocol server 不等于真实生产业务 server。** 本章证明 bridge 的协议与生命周期链路，不证明 fixture 具备生产权限、安全、可用性或远程部署质量。

## 手把手实验

### 第 0 步：先预测

运行前写下答案：

1. `course_lookup` 和 `mcp__course_fixture__course_lookup` 哪一个会出现在 `ctx.tools.schemas()`？
2. public name 是否会原样发送到 MCP `tools/call`？
3. `{ concept: 'unknown' }` 会得到 DSH `INVALID_ARGS`，还是 MCP JSON-RPC `-32602`？
4. 参数失败后，下一次有效 handler 调用的 `callCount` 应该是 1 还是 2？
5. Plugin Fiber dispose 只注销 tool，还是也应该停止 child process？

### 第 1 步：分清纯 contract 与 executable

先打开 [`src/fixture-contract.ts`](src/fixture-contract.ts)。它只有两个 `as const` raw names，没有创建 `McpServer`、读取 stdin 或启动进程。

再打开 [`src/local-fixture-server.ts`](src/local-fixture-server.ts)。文件末尾有顶层：

```ts
await server.connect(new StdioServerTransport())
```

所以它是 child executable，不应为了导入常量而被 parent lab import。把共享常量单独拆出，是避免 import side effect 污染 Host 的工程边界。

### 第 2 步：确认 fixture 是“真实协议 + 确定性业务”

在 server 文件里找到：

```ts
new McpServer(...)
server.registerTool(...)
new StdioServerTransport()
```

这些来自官方 MCP SDK。然后找到 `explanations`、`lookupCalls` 和 `course_fail`：这些是课程自写、固定可断言的业务 fixture。

两句话都要成立：

- 不是 mock MCP client；
- 也不是生产 MCP server。

### 第 3 步：运行 assert demo

在仓库根目录运行：

```bash
pnpm demo:s11
```

demo 不是只打印日志。任何 discovery、name、error 或 lifecycle 断言失败，进程都会非零退出。

### 第 4 步：从 discovery 找 public schema

打开 [`src/mcp-bridge-lab.ts`](src/mcp-bridge-lab.ts)，找到：

```ts
const bridgeFiber = root.plugin(McpClient, bridgeConfig)
await bridgeFiber.await()
const schemas = root.tools.schemas()
```

确认 `await()` 在读取 schemas 之前。如果删除它，parent 可能在首次 connect/discovery 完成前读取 Registry，制造时序竞争。

查看 demo 第一组输出，应该只有两个 public names，不应出现两个 raw names。

### 第 5 步：沿 public → raw 追一次调用

按以下顺序读：

1. `PUBLIC_LOOKUP_TOOL_NAME` 如何由 server name 与 raw name组成；
2. lab 如何把 public name 交给 `root.tools.execute()`；
3. fixture handler 为什么能返回 `rawToolName: 'course_lookup'`；
4. raw name 直调为什么得到 `UNKNOWN_TOOL`。

不要把 public name 按字符串切割后自己实现一层 dispatcher。真实 bridge 已经在 discovery 时把 raw identity 闭包进 Tool Definition。

### 第 6 步：读参数失败，而不是套用 S05 答案

找到 `serverArgumentError`。它发生在首次成功调用之前：

```text
invalid concept → MCP -32602
valid plugin    → structuredContent.callCount = 1
```

如果你只断言 `isError: true`，还不能证明 handler 没运行；`callCount: 1` 才把 schema gate 的位置变成可观察证据。

再和 S05 对比：

```text
S05 defineTool invalid args → DSH INVALID_ARGS
S11 MCP invalid args        → MCP server -32602
```

### 第 7 步：区分两种 MCP 失败

本章有两条 server-side 失败路径：

1. 参数不符合 `inputSchema`：server SDK 在 handler 前返回 `-32602`；
2. 参数有效，但 handler 返回 `isError: true`：bridge 用 handler 的 MCP content 构造普通 Error。

两者最终都是 `ToolExecutionResult.isError = true`，但 message 不同，也都不应凭空标成 DSH `INVALID_ARGS`。

### 第 8 步：观察 dispose 的两个世界

成功 handler 返回自己的 `process.pid`。lab 先确认该 PID 存活，然后：

```ts
await bridgeFiber.dispose()
```

dispose 后同时检查：

- ToolRuntime 世界：schemas 清空，public name 变成 `UNKNOWN_TOOL`；
- OS process 世界：signal-0 probe 找不到原 child PID。

单测不会读取上游私有 transport field，也不会自己 kill child 来伪造 plugin cleanup。

### 第 9 步：做一次原创修改

不要只停在运行现成 demo。自己加入第四个可查询概念 `mcp`：

1. 扩展 fixture 的 `conceptSchema`；
2. 为 `explanations.mcp` 写一句你自己的定义；
3. 把 lab 的成功调用改为 `{ concept: 'mcp' }`；
4. 更新 structured content type、demo 与行为测试；
5. 保留 invalid concept 负例和 `callCount: 1` 断言。

修改完成后，用一句话解释为什么只改 model-facing TypeScript type、不改 server schema，会造成契约漂移。

## 负向实验

### 负例 1：把 raw name 当 public name

课程已经执行：

```ts
name: 'course_lookup'
```

预期是 `UNKNOWN_TOOL`。这证明 raw name 没有泄漏到 Registry；不能把失败解释成 “MCP server 没启动”，因为同一场景随后用 public name 成功调用了它。

### 负例 2：传入 schema 外的 enum

课程已经执行：

```ts
arguments: { concept: 'unknown' }
```

预期 message 包含 `MCP error -32602: Input validation error`，`error.info` 不含 DSH `INVALID_ARGS`，随后有效结果仍是 `callCount: 1`。

### 负例 3：让 handler 明确返回 `isError`

调用 `mcp__course_fixture__course_fail`。预期：

- `isError === true`；
- error message 保留 `[local fixture] rejected: ...`；
- 没有成功 canonical `value`；
- 不伪造稳定 DSH error code。

### 负例 4：在 dispose 后继续调用

Plugin Fiber dispose 后再次执行 public name。预期得到 `UNKNOWN_TOOL`，而不是尝试向已关闭 child stdin 写请求。

### 负例 5：故障注入 startup command

先保留原值，然后临时把 [`src/mcp-bridge-lab.ts`](src/mcp-bridge-lab.ts) 的：

```ts
command: process.execPath
```

改成一个本机不存在的明确命令名。保持：

```ts
failOnStartupError: true
reconnect: { enabled: false }
```

重新运行 demo，预期 Plugin activation 非零失败，且没有发现任何 MCP tool。恢复原值后复跑全部验收。不要为了让测试“继续”把 startup error 吞掉。

## 预期观察

demo 的关键输出应接近：

```text
PASS 1/4：真实 MCP stdio discovery 把 raw tools 注册成 server-qualified public names
  discovered: mcp__course_fixture__course_lookup, mcp__course_fixture__course_fail

PASS 2/4：public definition 命中闭包保存的 raw name，MCP server 在 handler 前拒绝错误参数
  raw direct call: UNKNOWN_TOOL
  invalid args:    MCP error -32602: Input validation error ...
  server observed: course_lookup, callCount=1

PASS 3/4：MCP isError 跨过协议桥后仍是模型可见的 ToolRuntime 失败
  result: [local fixture] rejected: expected boundary probe

PASS 4/4：MCP Plugin Fiber dispose 同时注销工具并停止 local fixture 子进程
  child alive before dispose: true
  child stopped:              true
  disposed call:              UNKNOWN_TOOL
```

自动测试还应给出：

```text
Test Files  2 passed (2)
Tests       13 passed (13)
```

最终数字以仓库当前 test runner 输出为准；判断重点是所有行为与章节契约测试通过，不是背诵数字。

## 对照真实源码

课程固定上游 commit：

```text
b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
```

固定入口：

- [`packages/mcp/mcp-client`](https://github.com/deepseek-ai/deepseek-harness/tree/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client)：package README、公开 plugin 与测试总入口；
- [`src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/src/index.ts)：namespace plugin、Config、serverName reservation 与 effect-scoped apply；
- [`src/connection.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/src/connection.ts)：initial readiness、generation、reconnect 与 dispose；
- [`src/tools.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/src/tools.ts)：raw/public naming、tools/list sync、tools/call 与 MCP result mapping；
- [`src/transport.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/src/transport.ts)：stdio / Streamable HTTP transport factory 与 child env scrubbing；
- [`tests/mcp-client.e2e.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/mcp/mcp-client/tests/mcp-client.e2e.ts)：上游真实协议行为参考。

本章只阅读上游 e2e 来确认公开行为；没有 import、复制或运行上游 `tests/fixture-server.ts`。课程 fixture 的 tool names、payload、计数证据与 lifecycle probe 都在本章独立设计。

本章直接组合的公开包版本：

- `@deepseek-ai/cordis@4.0.1`
- `@deepseek-ai/dsh-mcp-client@0.1.1-rc.2`
- `@deepseek-ai/dsh-system-prompt@0.1.1-rc.2`
- `@deepseek-ai/dsh-tools@0.1.1-rc.2`
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`
- `@modelcontextprotocol/sdk@1.29.0`
- `zod@4.4.3`

## 验收

先跑本章：

```bash
pnpm demo:s11
pnpm test:s11
```

再跑仓库级门禁：

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
```

完成原创 `mcp` 概念修改后，逐项回答：

- [ ] 我能画出 Host → Client bridge → stdio transport → Server 的边界。
- [ ] 我能解释 raw name 为什么不直接注册到全局 ToolRuntime。
- [ ] 我能说明 public name 为什么不会原样发到 MCP wire。
- [ ] 我能解释本章参数错误为什么是 MCP `-32602`，不是 DSH `INVALID_ARGS`。
- [ ] 我能用 `callCount` 证明 schema failure 没进入 handler。
- [ ] 我能区分 protocol request failure 与 handler `isError` result。
- [ ] 我能指出 canonical `McpResult` 与 model-facing `content` 的区别。
- [ ] 我能证明 Plugin Fiber dispose 同时清理 tool registration 与 child process。
- [ ] 我能清楚标注哪些是生产公开实现，哪些是课程 local fixture。
- [ ] 我完成了自己的修改，而不是只运行课程现成代码。

课程章节建设完成不等于个人掌握。只有亲手完成修改、负例和解释，才把本章学习验收为 `Pass`。

## 教学简化与生产边界

本章为了把 MCP bridge 单独看清，做了这些简化：

- 只有一个 local stdio server，没有 HTTP、网络失败或身份认证；
- server 只有两个确定性 tools，没有真实业务数据和外部副作用；
- `reconnect.enabled` 设为 false，不展开 crash recovery；
- `failOnStartupError` 设为 true，让课程初始化失败直接可见；
- 直接使用 ToolRuntime，不重复 S06 的 keyless AgentLoop；
- 只使用 text content，不挂载 attachment store；
- child lifecycle 用 PID signal-0 观察，当前课程验证目标是 macOS/Linux；
- 没有把 server 进程当 sandbox，child 仍继承经过 bridge scrub 后的环境和本机用户权限。

生产化至少还要判断：

1. server 包、command 或 remote URL 是否可信、版本是否固定；
2. stdio child 能访问哪些文件、网络、凭据和系统调用；
3. HTTP transport 的认证、TLS、header secret 与租户隔离；
4. startup、tool call 与 reconnect 的 timeout / retry / backoff；
5. tool list change 是否影响 prompt 稳定性和缓存；
6. 多 server 同名、长名称 normalization 与 registry conflict；
7. 大结果、rich content、attachment persistence 与数据泄露；
8. 日志能否关联 public name、raw name、server、call id 与失败阶段；
9. Plugin reload / Host shutdown 时是否确认所有 in-flight calls 与 child resources 停稳。

MCP bridge 扩大了 Agent 能触达的能力面。成功连上 server 只是集成开始，不是权限审计和生产验收结束。

## 上游观察卡

### 观察

上游 README 清楚说明 public/raw naming 与 `client.callTool()` 转发，但学习者容易把 S05 的经验直接套过来，预期所有参数错误都由 ToolRuntime 产生 `INVALID_ARGS`。

固定 rc.2 的真实行为是：MCP bridge 将 server `inputSchema` 作为 model-facing parameters 注册；执行时把参数转发给 server，本章的 enum error 由 MCP Server SDK 返回 `MCP error -32602`。它在 handler 前失败，但不是 DSH `ToolArgsError`。

### 最小复现

```text
1. MCP server 发布 inputSchema: concept ∈ plugin/effect/fiber
2. bridge discovery 后，用 public name 调用 { concept: "unknown" }
3. ToolExecutionResult.isError = true
4. error.message 包含 MCP error -32602
5. error.info.code 不是 INVALID_ARGS
6. 下一次首次有效 handler 调用返回 callCount = 1
```

### 判断

这是值得上游补充的文档澄清候选，目前没有证据表明是实现 bug。可以在 MCP client README 的 Tool execute / error behavior 中明确：server-advertised input schemas负责模型呈现，具体 invalid-argument error shape 由 MCP server/protocol 返回，不保证映射为 DSH `INVALID_ARGS`。

### 贡献边界

如果准备上游贡献，先写一个只针对公开行为的最小测试或 docs diff，并询问维护者是否希望统一错误分类。不要为了得到熟悉的 code，就在课程仓库复制 bridge 或改变上游 error semantics。
