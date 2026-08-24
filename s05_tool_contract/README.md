# 05：Tool contract——从模型参数到 canonical result

> 一句话目标：直接使用真实 `ToolRuntime` 与 `defineTool`，让同一份 `course_add` 定义完成 model-facing schema、参数校验、canonical output 校验和结果渲染的完整闭环。

- 上一章：[04 Projection replay](../s04_projection_replay/)
- API Key：不需要
- 本章核心增量：把一个普通 TypeScript 函数升级为可被 Harness 展示、注册、校验、执行和观察的 Tool contract
- 下一章：[06 Keyless agent loop](../s06_keyless_agent_loop/)（复用本章 `courseAddToolPlugin`）

## 问题

一个普通函数已经可以完成加法：

```ts
const add = (left: number, right: number) => left + right
```

但 Agent Harness 还需要回答一组普通函数没有回答的问题：

- 模型怎样知道这个能力叫什么、接收哪些参数？
- 模型传来字符串 `"22"` 时，谁在真正的执行边界拒绝它？
- body 返回的值怎样证明符合约定，而不只是“TypeScript 编译通过”？
- 结构化结果怎样转换成模型收到的 `content`？
- Plugin 卸载后，工具是否还残留在 Registry？

本章用真实 `@deepseek-ai/dsh-tools@0.1.1-rc.2` 回答这些问题。我们不会调用模型，而是用一个确定性 driver 构造与模型相同格式的 tool call，再让真实 Registry 完成执行。

## 先认识八个基本概念

### 1. `ToolDefinition`：工具的完整 host 定义

Tool 不只是一个 `execute` 函数。`ToolDefinition` 同时包含：

```text
模型需要知道的字段       host 运行时需要的字段
name                    execute
description             output.schema
parameters              output.render
```

前一列会投影成 `ToolSchema`；后一列留在进程内，绝不能作为函数 schema 发给模型。

### 2. `ToolSchema`：模型真正看到的能力说明

`ToolSchema` 只有 `name`、`description`、`parameters`。本章同时读取：

```ts
ctx.tools.schemas()
ctx.systemPrompt.assemble().tools
```

两条路径应该得到同一个 `course_add` schema。`ctx.tools.schemas()` 使用 allowlist，不会泄漏 `execute` 或 `output` 回调。

### 3. `defineTool`：把类型推导与 runtime validation 绑在一起

[`courseAddTool`](src/course-add-tool.ts) 不是手写 `ToolDefinition`，而是由 `defineTool({...})` 产生。

它会根据 `parameters` 推导 body 的 `args` 类型，并在 user body 前执行 runtime validation。TypeScript 负责作者写代码时的反馈；runtime validation 负责模型 JSON 到达执行边界后的事实。

### 4. `parameters`：model-facing input schema

本章声明两个必填整数：

```ts
parameters: {
  left: { type: 'integer', required: true },
  right: { type: 'integer', required: true },
}
```

`defineTool` 会把它编译成标准 JSON Schema object，并生成 `required: ['left', 'right']`。

参数根是隐式开放 object，额外的顶层字段默认不会因为未声明而失败；本章不把“拒绝额外顶层字段”当成已提供能力。显式嵌套 object 才能通过 `additionalProperties: false` 声明关闭。

### 5. `execute`：只返回 canonical value

通过参数校验后，真实 body 收到推导好的 `{ left: number; right: number }`，并返回：

```ts
{ sum: 42 }
```

这份结构化 JSON 是 canonical value。body 不直接拼模型文本，也不返回“成功/失败”包装；Registry 拥有结果规范化。

### 6. `output.schema`：验证 body 的结构化结果

本章的输出契约是一个关闭的 object：

```ts
{
  type: 'object',
  additionalProperties: false,
  properties: {
    sum: { type: 'integer', required: true },
  },
}
```

即使作者用类型断言、动态数据或外部响应绕过了 TypeScript，Registry 仍会在 runtime 验证 canonical value。错误值不会伪装成成功结果。

Native mode 下，`output.schema` 是 host contract，不属于模型看到的 `ToolSchema`。以后进入 Code Mode 时，它还可以参与生成 typed SDK；本章不展开该机制。

### 7. `output.render`：canonical value 到模型 `content`

校验成功后，`output.render(args, value)` 才把结构化值投影成：

```ts
[{ type: 'text', text: '计算结果：20 + 22 = 42' }]
```

因此成功的 `ToolExecutionResult` 同时携带两种用途不同的结果：

- `value`：进程内程序继续组合能力时使用的 canonical JSON；
- `content`：模型、日志和 Native tool result 使用的呈现内容。

改变 `content` 不等于改变 canonical value；两者不能混为一份字符串。

### 8. Registry、`execute` 与结果观察

`ToolRuntime` 暴露为 `ctx.tools`：

- `ctx.tools.register()`：接收一个 definition，把它注册到调用 Plugin 的作用域，并返回 disposer；注册也随调用方 Fiber 自动清理。
- `ctx.tools.schemas()`：读取当前可见的 model-facing schemas。
- `ctx.tools.execute()`：接收一个 execution input，运行真实参数快照、校验、body、output validation、render 与结果规范化流水线。

一次最小调用还需要：

- `CallId`：关联本次 tool call 的 opaque id；
- `AbortSignal`：调用方拥有的取消信号，本章传入未取消的 signal，不学习取消策略；
- `ToolExecutionResult`：以 `isError` 区分成功和失败。普通参数/body 错误会 resolve 为 error result，而不是要求调用方捕获 throw。

本章用 live `tools/result` 观察最终结果。它与 Session 中的 durable `tool/result` 不是一回事：后者由下一章的 AgentLoop 在调用配对后追加。

## 你会交付什么

本章完成四段真实证据：

1. `course_add` 同时出现在 Registry 与 SystemPrompt assembly 中，且 model-facing schema 不含 host 回调。
2. `{ left: 20, right: 22 }` 得到 canonical `{ sum: 42 }` 与 rendered `content`。
3. 字符串参数得到 `INVALID_ARGS`；故障 body 得到 `INVALID_TOOL_OUTPUT`。
4. Tool Plugin Fiber dispose 后 schema 消失，再调用得到 `UNKNOWN_TOOL`。

代码与证据：

- [`src/course-add-tool.ts`](src/course-add-tool.ts)：唯一正式 `course_add` 定义与供 S06 复用的 Plugin。
- [`src/tool-contract-lab.ts`](src/tool-contract-lab.ts)：真实 composition、确定性 driver、结果观察和故障探针。
- [`src/demo.ts`](src/demo.ts)：带 `assert` 的可观察输出。
- [`tests/tool-contract.test.ts`](tests/tool-contract.test.ts)：schema、正例、两类 contract failure 与 dispose 测试。

## 机制图

```text
courseAddToolPlugin（inject: tools）
              |
              v
ctx.tools.register(courseAddTool)
              |
       +------+-----------------------------+
       |                                    |
       v                                    v
ctx.tools.schemas()                 ctx.tools.execute(call)
       |                                    |
       v                                    v
name / description / parameters     snapshot arguments
       |                                    |
       v                                    v
SystemPrompt assembly               parameters runtime validation
                                            |
                             INVALID_ARGS <-+-> execute(args)
                                                    |
                                                    v
                                             canonical value
                                                    |
                                                    v
                                             output.schema
                                                    |
                         INVALID_TOOL_OUTPUT <-+----+----+-> output.render
                                                              |
                                                              v
                                                  ToolExecutionResult
                                                    value + content
                                                              |
                                                              v
                                                        tools/result
```

这张图没有 `tool/call` 与 durable `tool/result`，因为直接调用 Registry 不会替 AgentLoop 写 Session 日志。

## 本章边界

本章只使用一个无状态、确定性的 `course_add` 与默认 `native` presentation。

真实 composition 是：

```text
Context
  ├─ SystemPrompt
  ├─ ToolRuntime { mode: 'native' }
  └─ courseAddToolPlugin { inject: ['tools'] }
```

固定公开包：

- `@deepseek-ai/cordis@4.0.1`
- `@deepseek-ai/dsh-system-prompt@0.1.1-rc.2`
- `@deepseek-ai/dsh-tools@0.1.1-rc.2`
- `@deepseek-ai/dsh-llm@0.1.1-rc.2`

有意不进入：

- LLM provider、真实模型请求和 API Key；
- Agent、AgentLoop 与 Session 的 `tool/call` / `tool/result` 配对；
- permission、approval、guard 和 sandbox；
- timeout、abort 协作、retry 与并发调度；
- Code Mode、`run_code` 与 typed SDK；
- UI 的 `presentCall` / `presentResult`；
- raw JSON Schema ToolDefinition 与 MCP 动态工具。

## 手把手实验

### 第 0 步：先预测

运行前回答：

1. 模型会看到 `execute` 和 `output.schema` 吗？
2. `right: "22"` 会进入 user body，还是在它之前失败？
3. body 返回 `{ sum: "42" }` 时，renderer 会不会收到这个值？
4. `courseAddToolPlugin` dispose 后，Registry 还能找到工具吗？
5. `tools/result` 会不会自动在 Session 中生成 durable `tool/result`？

### 第 1 步：读唯一正式定义

打开 [`src/course-add-tool.ts`](src/course-add-tool.ts)，按顺序定位：

1. `COURSE_ADD_TOOL_NAME`
2. `parameters`
3. `output.schema`
4. `output.render`
5. `execute`
6. `courseAddToolPlugin`

先不要读故障探针。用一句话复述：模型输入、canonical value 与模型 content 分别由哪个字段拥有。

### 第 2 步：确认真实 Service composition

打开 [`src/tool-contract-lab.ts`](src/tool-contract-lab.ts) 的 `createToolContractHarness()`：

```ts
await root.plugin(SystemPrompt)
await root.plugin(ToolRuntime, { mode: 'native' })
const toolFiber = root.plugin(courseAddToolPlugin)
```

`ToolRuntime` 依赖 `systemPrompt`，因为它要把当前可见 tool schemas 贡献给模型请求 assembly。Tool Plugin 自己只 `inject: ['tools']`，不依赖具体 Registry class。

### 第 3 步：比较两条 schema 路径

找到：

```ts
root.tools.schemas()
root.systemPrompt.assemble()
```

两处都只应出现 `name`、`description`、`parameters`。这是“模型能调用什么”的公开投影，不是把整个 host object 序列化出去。

### 第 4 步：沿成功调用走一遍

找到 `s05-valid`：

```ts
arguments: { left: 20, right: 22 }
```

按这条路径逐项核对：

```text
arguments validation
  → execute
  → { sum: 42 }
  → output.schema validation
  → output.render
  → value + content
```

### 第 5 步：运行 demo

```bash
corepack pnpm demo:s05
```

demo 自带 `node:assert/strict`。如果只打印 PASS 而不检查值，课程回归时很容易留下“看起来运行了”的假证据。

### 第 6 步：运行自动测试

```bash
corepack pnpm test:s05
```

测试会分别验收 schema presentation、成功 value/content、`INVALID_ARGS`、`INVALID_TOOL_OUTPUT`、`tools/result` 观察顺序和 Fiber dispose。

### 第 7 步：做自己的正向修改

只修改 [`src/tool-contract-lab.ts`](src/tool-contract-lab.ts) 中成功调用的输入，例如改为：

```ts
arguments: { left: 19, right: 23 }
```

同步修改 demo 与测试中 rendered content 的预期，然后运行：

```bash
corepack pnpm test:s05
corepack pnpm demo:s05
```

验收重点：canonical value 仍为 `{ sum: 42 }`，renderer 中的算式变为 `19 + 23 = 42`。不要复制第二份 `course_add` 定义。

## 负向实验

### 负例一：模型参数不符合 `parameters`

lab 已调用：

```ts
arguments: { left: 20, right: '22' }
```

预期 `ToolExecutionResult`：

```text
isError = true
error.info.name = ToolArgsError
error.info.code = INVALID_ARGS
value 不存在
```

这不是 TypeScript 编译实验；错误 JSON 已经进入真实 `ctx.tools.execute()`，由 `defineTool` 的 runtime wrapper 在 user body 前拒绝。

### 负例二：body 违反 `output.schema`

[`src/tool-contract-lab.ts`](src/tool-contract-lab.ts) 中的 `invalidOutputTool` 只用于故障注入。它复用正式工具的 parameters 和 output contract，但故意返回：

```ts
{ sum: 'forty-two' }
```

预期：

```text
isError = true
error.info.name = ToolOutputError
error.info.code = INVALID_TOOL_OUTPUT
value 不存在
```

亲手做一次故障注入：

1. 临时把正式 `courseAddTool.execute` 的返回值改为错误字符串，并用显式类型断言模拟“不可信外部响应绕过静态检查”。
2. 运行 `corepack pnpm test:s05`。
3. 预期原来的成功调用变成 `INVALID_TOOL_OUTPUT`，成功结果测试失败。
4. 恢复 `{ sum: args.left + args.right }`，重新运行直到全绿。

类型断言不是修复方案；它只是让学习者真正到达 runtime output boundary。

### 负例三：注册拥有生命周期

lab dispose `courseAddToolPlugin` 的 Fiber 后，再执行同名工具。预期：

```text
ctx.tools.schemas() 不再包含 course_add
error.info.code = UNKNOWN_TOOL
```

如果工具仍可执行，说明注册没有跟随 Plugin 生命周期释放。

## 预期观察

关键输出如下：

```text
PASS 1/4：同一 model-facing schema 同时来自 Registry 与 SystemPrompt assembly
  schema: {"name":"course_add",...}

PASS 2/4：有效参数得到 canonical value，再由 renderer 产生 content
  value:   {"sum":42}
  content: [{"type":"text","text":"计算结果：20 + 22 = 42"}]

PASS 3/4：参数错误与 body 输出错误被规范化成不同错误码
  invalid args:   INVALID_ARGS
  invalid output: INVALID_TOOL_OUTPUT

PASS 4/4：Tool Plugin Fiber dispose 后，注册消失且调用变成 UNKNOWN_TOOL
  schemas after dispose: []
  disposed call:         UNKNOWN_TOOL
```

四次 live `tools/result` 观察顺序应为：

```text
s05-valid:OK
→ s05-invalid-args:INVALID_ARGS
→ s05-invalid-output:INVALID_TOOL_OUTPUT
→ s05-after-dispose:UNKNOWN_TOOL
```

## 对照真实源码

课程固定上游：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。

按本章执行路径阅读，不要先通读整个 tools 子系统：

1. [`packages/core/tools/src/schema.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/schema.ts)：`defineTool`、参数 schema 编译、`ToolArgsError` 与 user body wrapper。
2. [`packages/core/tools/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/index.ts)：`ToolRuntime.register()`、`schemas()`、`execute()`、output validation、render 与最终结果。
3. [`packages/core/tools/tests/tools.spec.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/tests/tools.spec.ts)：上游自己的 round-trip、参数/输出错误和 Fiber dispose 证据。
4. [`packages/core/system-prompt/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/system-prompt/src/index.ts)：tool schema provider 怎样进入 assembly。
5. [`packages/todo/tool-todo/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/todo/tool-todo/src/index.ts)：真实一方 Tool Plugin 的 `inject → register(defineTool) → canonical output → render` 模式。
6. [`docs/cordis-tutorial/07-into-the-harness.zh.md`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cordis-tutorial/07-into-the-harness.zh.md)：上游 keyless 最小 composition。
7. [`packages/core/agent-loop/src/tool-calls.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent-loop/src/tool-calls.ts)：确认 durable `tool/call` / `tool/result` 属于下一章 AgentLoop，而不是本章直接 Registry 调用。

源码检查问题：

1. `defineTool` 在哪里调用参数 validator，为什么错误参数到不了 user body？
2. `schemas()` 为什么显式挑选字段，而不是展开整个 definition？
3. Registry 在什么顺序验证 canonical value 与调用 renderer？
4. `register()` 返回的 disposer 怎样附着到调用 Fiber？
5. `tools/result` 与 AgentLoop 追加 `tool/result` 的职责为什么要分开？

## 验收

完成本章需同时满足：

- [ ] 能解释普通函数、`ToolDefinition` 与 `ToolSchema` 的差别。
- [ ] 能指出 `parameters`、`execute`、`output.schema`、`output.render` 各自拥有的边界。
- [ ] `corepack pnpm demo:s05` 通过四段 assert。
- [ ] `corepack pnpm test:s05` 全绿。
- [ ] 能从成功结果中分别指出 canonical `value` 与 rendered `content`。
- [ ] 能解释 `INVALID_ARGS` 与 `INVALID_TOOL_OUTPUT` 分别发生在 body 的哪一侧。
- [ ] 亲手完成一次 output 故障注入、看到失败并恢复。
- [ ] 能证明 Fiber dispose 后 schema 消失且执行返回 `UNKNOWN_TOOL`。
- [ ] 能解释本章为什么没有产生 Session durable `tool/result`。
- [ ] 正向修改后仍只保留一个正式 `course_add` 定义，S06 可以直接复用。

## 教学简化与生产边界

### 真实部分

- 使用 npm 已发布的 `SystemPrompt`、`ToolRuntime`、`defineTool` 与 `CallId`。
- 工具通过真实 Plugin `inject` 和 Registry effect 注册。
- 参数和 output 都经过真实 runtime schema validation。
- 成功、失败、注销后调用都经过真实 `ctx.tools.execute()`。
- `tools/result` 是真实 observe-only live event。

### 教学简化

- `course_add` 是纯确定性能力，没有文件、网络或数据库副作用。
- driver 代替模型构造 tool call，但不伪装成 LLM 或 AgentLoop。
- 故障工具故意违反 body contract，只用于证明 runtime output boundary。
- 本章只使用 `native` mode，不比较 Code Mode presentation。
- 每次调用传入新的未取消 `AbortSignal`，不证明 cancellation 或 timeout。

### 不应得出的结论

- 通过本章不代表已经实现完整 Agent；S06 才组合 fake LLM 与真实 AgentLoop。
- `tools/result` 被观察不代表 durable `tool/result` 已写入 Session。
- `timeoutMs` 声明不等于已执行 timeout；它需要专门 policy wrapper。
- TypeScript 推导不能替代 runtime validation，runtime validation 也不能表达所有业务规则。
- `content` 是 presentation，不是可供程序可靠组合的 canonical value。
- 课程没有重写 Tool Registry、dispatcher 或 JSON Schema validator。

## 上游观察卡

完成实验后填写：

```text
我观察的 symbol：
它属于 definition / registry / execution / presentation 哪一层：
本章哪条测试证明了它：
参数失败时 user body 是否运行，证据是什么：
output 失败时 renderer 是否运行，证据是什么：
tools/result 与 tool/result 的职责差别：
Fiber dispose 后 Registry 的可见变化：
我仍然不能解释的一个问题：
```

建议只记录亲手运行和故障注入得到的证据，不把“课程代码已存在”记成个人已经掌握。
