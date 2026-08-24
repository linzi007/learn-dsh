# 第 13 章：综合项目——Keyless Mini Coding Harness

上一章：[12 Subagent 与 Worker Workflow](../s12_subagent_workflow/)

课程收尾：[返回 Learn DSH 课程首页](../README.md)

前十二章分别拆开了 lifecycle、Service、Session、Projection、Tool、AgentLoop、Approval、Persistence、Background jobs、Compaction、MCP 和 Subagent / Workflow。最后一章把其中最接近 coding agent 主干的机制重新接成一条可运行链路：一个没有 API Key 的 mini coding harness 读取并编辑真实临时文件，写下审批审计，落盘 Session，然后在全新 Context 中恢复工作。

这里的 “keyless” 只表示课程不请求真实模型。模型响应由第 6 章的 `ScriptedLlmAdapter` 明确替代；AgentLoop、文件工具、文件提供方、观察策略、Approval、Session 和 JSONL persistence 都是真实上游实现。

课程固定使用 DeepSeek Harness `0.1.1-rc.2`，对应上游 commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。

## 问题

一个 coding harness 不只是“让模型输出一段代码”。即便只改一个文件，也至少要回答这些问题：

- 相对路径到底相对于哪里解析？
- `cwd` 是工作目录，还是安全边界？
- `../outside.txt` 和指向外部的 symlink 会不会逃逸？
- 修改文件为什么需要先读？
- 人类批准一次 `edit` 后，下一次是否自动获得授权？
- Session transcript 落盘以后，进程内的 policy cache 会一起落盘吗？
- 恢复后的 Agent 如何知道第一次 edit 为什么失败、该怎样修复？
- 工具结果、审批和文件最终状态怎样互相核对？
- Context、Agent、Session 与临时文件由谁清理？

本章用一个小而完整的实验回答这些问题，不把“demo 能改文件”误写成“生产级安全 coding agent”。

## 先认识十二个基本概念

### 1. Mini coding harness

Harness 是连接模型、上下文、工具、策略、持久化与生命周期的宿主。模型可以提出 `read` / `write` / `edit` 调用，但是否执行、如何执行、执行结果怎样回到下一次模型请求，都由 harness 决定。

本章只处理一个课程文件 `lesson.md`。范围小，但主链完整：

```text
user message
  → AgentLoop
  → ScriptedLlmAdapter 提出 tool call
  → ToolRuntime policy / Approval
  → ToolFs
  → LocalFileSystem
  → tool/result
  → 下一次模型请求
  → Session JSONL
```

### 2. `ScriptedLlmAdapter` 与 keyless

`ScriptedLlmAdapter` 是本章唯一的 fake。它按预定顺序返回公开 `StreamChunk` 协议，所以实验不访问网络、不读取 Key，也没有 token 成本。

它不是把所有结果都写死。两个 Context 的最后一步使用函数脚本，从本次 `GenerateOptions.messages` 里找到真实 `tool-result`，再动态形成 assistant 文本。若真实工具的成败与预期不同，脚本会抛错，demo 不会假装成功。

因此，本章能证明 harness 组合与失败恢复；它不能证明真实模型会稳定选择正确工具、参数或重试策略。

### 3. 文件系统四层栈

本章使用固定上游的四层设计：

| 层 | 包 | 本章作用 |
| --- | --- | --- |
| 工具 / 执行器 | `@deepseek-ai/dsh-tool-fs` | 向模型公开 `read`、`write`、`edit`，负责 schema、渲染和 `fs/*` 事件 |
| 观察策略 | `@deepseek-ai/dsh-fs-observation-policy` | 记录已读版本，要求 edit 前先观察，并给 mutation 加版本防护 |
| 能力 seam | `@deepseek-ai/dsh-fs` | 定义 `ctx.fs.resolve`、`contains`、文本 I/O 和结构化错误 |
| 本地提供方 | `@deepseek-ai/dsh-fs-local` | 在宿主临时目录上实现真实文件读取与原子 mutation |

`ToolFs` 还拥有 `read_image`，但它只在持久 attachment service 已挂载时注册。本章不处理图片，因此有效工具是 `read`、`write`、`edit`。

### 4. `Session.header.cwd`

`ToolFs` 解析相对 `file_path` 时，优先使用调用 Agent 的 `Session.header.cwd`。本章创建 Agent 时显式写入：

```ts
ctx.agents.create({
  sessionId,
  meta: { cwd: workspace },
  // ...
})
```

`workspace` 是 `mkdtemp` 下的绝对目录。Context B resume 时不再传 cwd，而是检查 JSONL header 恢复出的 cwd 与 Context A 完全相同。

注意：`LocalFileSystem({ cwd })` 和 `Session.header.cwd` 都是解析基准，不是 containment boundary。绝对路径和 `..` 仍可能离开它。

### 5. `FsTarget`、`resolve()` 与 `contains()`

`ctx.fs.resolve(path, { cwd })` 把输入路径解析成 `FsTarget`。对于本地后端，存在文件的 identity 基于 realpath：不同路径或 symlink 指向同一文件时会得到同一规范身份。

本章 policy 先解析精确 workspace，再解析每个工具目标，然后调用：

```ts
ctx.fs.contains(workspaceTarget, candidateTarget)
```

只有规范目标等于 workspace 或位于其后代时才继续。于是：

- `lesson.md` 在 workspace 内，可以继续；
- `../outside.txt` 解析到 workspace 外，拒绝；
- `escape-link.txt` 虽然路径文字位于 workspace 内，但 realpath 指向外部，仍拒绝。

消费方只使用 `contains()`，不解析不透明的 `targetKey`。

### 6. `tools/pre-execute` 路径 policy

[workspace-policy.ts](src/workspace-policy.ts) 安装应用层 `tools/pre-execute` listener：

```text
read inside workspace  → next()
write/edit inside      → ask
任何 workspace escape → deny
```

安全的 `read` 仍调用 `next()`，让后续 listener 保留收紧决定的机会。mutation 返回 `ask`，由 ApprovalService 决定是否 dispatch。越界路径直接 `deny`，所以不会到达 `tools/execute`，更不会进入 ToolFs body。

这是路径 / dispatch policy，不是 OS sandbox。它没有限制同进程其它代码、子进程、网络或直接 `ctx.fs` 调用。

### 7. `ApprovalService` 与 `allowed-once`

每个允许进入 body 的 `write` / `edit` 都要求本次调用的一次性 Approval。answerer 注册在 `handle.agent.ctx`，只回答这个 Agent 的 request，不用 root listener 误答其它 Agent。

主实验一共有三次批准：

1. Context A read 后的 edit；
2. Context B 恢复后第一次直接 edit；
3. Context B read 后的 retry edit。

三次结果都是 `allowed-once`，但没有任何一次授权被下一次复用。每次都留下独立的：

```text
tool/call → approval/asked → approval/decided → tool/result
```

第二次批准后工具仍然失败，因为 Approval 只决定是否 dispatch，不保证文件策略或 tool body 一定成功。

Context B read 后的重试仍需新 Approval；`allowed-once` 不会变成 Session 级授权。

### 8. `fs-observation-policy`

观察策略把状态保存在进程内 `WeakMap`，owner 是 `exec.agent.session` 对象。

成功 `read` 后，ToolFs 发出 `fs/observed`，记录目标存在以及当时的版本。之后的 `edit` 从 `fs/edit-intent` 取得这个版本，由 LocalFileSystem 在原子变更中检查文件是否仍然新鲜。

三种关键状态是：

```text
unseen         → edit: FS_NOT_OBSERVED
observed absent→ edit: FS_NOT_FOUND
observed present(version v)
               → edit with version guard
```

这既是“先读再改”的教学规则，也是避免基于过期内容静默覆盖的一层 freshness policy。

### 9. Transcript persistence 不等于 policy cache persistence

Context A 的 Session events、tool call、tool result 和 approval audit 都能写入 JSONL。Context B resume 后能重建这些 durable facts，也能继续 Turn 2。

但 observation `WeakMap` 不属于 Session log。Context A 的 Session 对象和 FsPolicy plugin 都已 dispose；Context B 创建了全新的对象。因此，即使历史明确记录过 `read lesson.md`，恢复后的第一次直接 `edit` 仍然得到：

```text
FS_NOT_OBSERVED
edit requires reading ".../lesson.md" first — read the file, then retry
```

随后 Context B 再执行一次真实 `read`，新 policy cache 得到当前版本，同样的 edit 重试才成功。

这是上游 rc.2 明确记录的限制，不是课程伪造的错误。

### 10. `JsonlSessionPersistence`、flush 与 resume

本章使用：

```ts
{
  compression: 'none',
  packChunks: false,
}
```

Context A 在 Turn 1 完整结束后显式 `ctx.sessions.flush(session)`，再 dispose AgentHandle 和 root Context。Context B 是全新的 root Context，通过 `ctx.agents.resume()` 加载同一个 Session id。

测试会逐项确认：

- Context A JSONL 事件行等于 Context A live events；
- Context B resume 的 durable prefix 等于 Context A events；
- `firstLiveSeq` 指向新的 `session/end-seed`；
- Turn 从 `1` 继续到 `2`；
- Context B flush 后 JSONL 事件行等于最终 live events。

### 11. Tool result 与审计证据

本章不只检查 assistant 最后一行文字。验收同时读取：

- `tool/call` 与 `tool/result` 配对；
- `tool/result.data.error.code` 中的 `FS_NOT_OBSERVED`；
- 三组 Approval 事件与递增 seq；
- `tools/execute` 的实际 dispatch CallId；
- JSONL 的物理事件；
- 独立 Node `readFile()` 看到的最终磁盘内容。

这让“模型说已经改好”和“文件确实按策略改好”成为两份独立证据。

### 12. Fixture 与 holder cleanup

课程 fixture 在系统临时目录创建唯一根：

```text
learn-dsh-s13-run-XXXXXX/
├── workspace/
│   ├── lesson.md
│   └── escape-link.txt -> ../outside.txt
├── outside.txt
└── sessions/
```

`outside.txt` 是醒目标注的测试 fixture，不是用户文件。Agent 的 cwd 只指向 `workspace/`；outside 文件只用于证明拒绝行为。

每个 Context 都按 `AgentHandle → root Context` 逆序释放。最后删除前再次确认目标是系统临时目录下一层、basename 以 `learn-dsh-s13-` 开头的精确 `mkdtemp` 返回值，不使用 glob、环境变量或宽泛目录。

## 你会交付什么

```text
s13_capstone/
├── README.md
├── notes.md
├── src/
│   ├── capstone-fixtures.ts
│   ├── capstone-harness.ts
│   ├── capstone-lab.ts
│   ├── demo.ts
│   └── workspace-policy.ts
└── tests/
    ├── capstone.test.ts
    └── chapter-contract.test.ts
```

- [capstone-harness.ts](src/capstone-harness.ts)：组合真实 AgentLoop、FS stack、Approval 与 JSONL persistence。
- [workspace-policy.ts](src/workspace-policy.ts)：symlink-aware workspace containment 与 mutation Approval。
- [capstone-lab.ts](src/capstone-lab.ts)：Context A / B 主场景、动态 scripted result 和审计投影。
- [capstone-fixtures.ts](src/capstone-fixtures.ts)：精确临时目录、外部负例与清理门禁。
- [demo.ts](src/demo.ts)：使用 `node:assert/strict` 的零 Key 综合演示。
- [capstone.test.ts](tests/capstone.test.ts)：持久化、观察、审批、路径逃逸、真实磁盘和清理行为测试。
- [chapter-contract.test.ts](tests/chapter-contract.test.ts)：中文章节结构、依赖、公开 API、固定上游和链接门禁。
- [notes.md](notes.md)：固定源码研究与组合决策。

## 机制图

```text
Context A（全新 root）
  │
  ├─ Agent Session meta.cwd = exact workspace
  ├─ read lesson.md
  │    ├─ pre-execute: contains = true → next
  │    ├─ ToolFs → LocalFileSystem.read
  │    └─ fs/observed(session A, file version v1)
  │
  ├─ edit lesson.md
  │    ├─ pre-execute: contains = true → ask
  │    ├─ Approval: allowed-once
  │    ├─ fs/edit-intent: version v1
  │    └─ LocalFileSystem.edit → success v2
  │
  ├─ sessions.flush() → session.jsonl
  └─ AgentHandle.dispose() → Context.dispose()

                    durable transcript only
                              │
                              ▼

Context B（另一个全新 root）
  │
  ├─ agents.resume(same Session id)
  │    ├─ header.cwd restored
  │    ├─ Turn 1 / tool / approval history restored
  │    └─ observation WeakMap = cold
  │
  ├─ edit lesson.md → ask → allowed-once
  │    └─ fs/edit-intent → FS_NOT_OBSERVED
  │
  ├─ read lesson.md → observe current v2
  ├─ edit lesson.md → ask again → allowed-once → success v3
  │
  ├─ write ../outside.txt
  │    └─ contains = false → deny before tools/execute
  │
  ├─ read escape-link.txt
  │    └─ resolve follows symlink → contains = false → deny
  │
  ├─ final scripted response reads five real tool-results
  ├─ sessions.flush()
  └─ dispose all → exact temp root cleanup
```

## 本章边界

### 哪些是真实上游实现

- Cordis `Context`、plugin、Service 与 Fiber dispose；
- `AgentRegistry`、真实 `AgentLoop`、Turn / Step 和 Session event；
- `ToolRuntime`、schema validation、pre/execute/result pipeline；
- `ToolFs` 的 `read` / `write` / `edit`；
- `LocalFileSystem` 的 realpath identity、读取、原子 edit；
- `fs-observation-policy` 的 WeakMap observation 与版本 guard；
- `ApprovalService`、agent-scoped answerer 和 durable audit；
- `JsonlSessionPersistence`、flush、resume 与 seed marker。

直接依赖固定为：

```text
@deepseek-ai/dsh-fs@0.1.1-rc.2
@deepseek-ai/dsh-fs-local@0.1.1-rc.2
@deepseek-ai/dsh-fs-observation-policy@0.1.1-rc.2
@deepseek-ai/dsh-tool-fs@0.1.1-rc.2
```

AgentLoop、Approval、Session 和 JSONL 等包沿用前章已经固定的同一版本。

### 唯一 fake 与教学 fixture

唯一 fake 是从第 6 章复用的 `ScriptedLlmAdapter`。它只替代模型输出。

`mountAgentLoopTestDependencies()` 是上游 testkit 提供的基础 Service 组合捷径，不是另一套 Agent 或模型替身；它只按公开测试组合挂载 Session、ToolRuntime、SystemPrompt 等前置依赖。生产应用通常会使用自己的 bundle / loader 显式选择这些插件。

`lesson.md`、`outside.txt`、`escape-link.txt` 与 JSONL 根都是本章在 `mkdtemp` 下创建的教学 fixture。它们不是仓库工作区、用户文件、真实模型会话或生产数据。

### 本章刻意不做什么

- 不请求真实 API Key，不评价模型的工具选择质量；
- 不修改课程仓库自身文件，Agent 只操作临时 workspace；
- 不提供 bash、进程、网络、删除、移动或递归搜索工具；
- 不把 LocalFileSystem 的 cwd、Approval 或 pre-execute policy 称为安全沙箱；
- 不验证多进程攻击者、恶意同进程插件或真实并发 symlink swap；
- 不把课程建设完成写成学习者已经掌握。

## 手把手实验

### 步骤 1：确认真实组合顺序

打开 [capstone-harness.ts](src/capstone-harness.ts)，依次找到：

```ts
mountAgentLoopTestDependencies(ctx)
ctx.plugin(ApprovalService, { policy: 'ask' })
ctx.plugin(LocalFileSystem, { cwd: fixture.workspace })
ctx.plugin(FsObservationPolicy)
ctx.plugin(ToolFs)
installWorkspaceToolPolicy(...)
ctx.plugin(AgentLoop, { agents: [] })
ctx.plugin(JsonlSessionPersistence, ...)
```

回答：为什么 LocalFileSystem 要在 ToolFs 前挂载？为什么 FsObservationPolicy 即使没有 Service API 也能改变 edit 行为？

### 步骤 2：看清 Agent 能操作的范围

打开 [capstone-fixtures.ts](src/capstone-fixtures.ts)。确认：

- workspace 和 persistence 位于同一个唯一临时根；
- `outside.txt` 不在 workspace 内；
- Agent Session 只得到 workspace cwd；
- symlink 的路径在 workspace 内，目标却在外面。

先预测：只做字符串前缀判断会在哪一个负例上出错？

### 步骤 3：跟踪 Context A

在 [capstone-lab.ts](src/capstone-lab.ts) 找到 `createContextAAdapter()`：

```text
request 1 → read lesson.md
request 2 → edit lesson.md
request 3 → 根据真实 edit tool-result 生成最终文本
```

注意 adapter 没有实现 read 或 edit。它只提出调用；真实工具结果由 AgentLoop 在下一次请求中交还给它。

### 步骤 4：检查一次性 Approval

找到 `installAllowedOnceAnswerer()`。answerer 注册在 `handle.agent.ctx`，不是 root `ctx`。

运行后检查三次审批 CallId。即使 Context B 第一次 edit 最终失败，它仍有完整 `allowed-once` 审计，因为审批发生在 `fs/edit-intent` 之前。

### 步骤 5：观察 flush 与完全释放

Context A 的顺序是：

```text
whenIdle()
→ sessions.flush()
→ 保存 live evidence
→ handle.dispose()
→ root Context dispose
```

不要把 `whenIdle()` 当成强制 persistence checkpoint；本章要读取物理 JSONL，所以显式 flush。

### 步骤 6：预测 Context B 第一次 edit

只看 transcript，很容易猜“Context A 已经 read 过，所以能 edit”。现在结合第 8 个概念重新预测。

运行 demo：

```bash
pnpm exec tsx s13_capstone/src/demo.ts
```

根脚本接入后也可以使用：

```bash
pnpm demo:s13
```

预期第一条恢复 edit 的结构化 code 是 `FS_NOT_OBSERVED`。

### 步骤 7：验证 read 后重试

Context B 不重建 Session，而是在同一个 Turn 的后续 Step 执行 read，再重试相同 edit。

检查：

- 第一次与第二次 edit 使用不同 CallId；
- 两次都单独 ask；
- 第一次 error，第二次 success；
- Node 独立读取磁盘时看到 `状态：Context B 恢复后编辑`。

### 步骤 8：验证两种路径逃逸

检查 `contextBPolicy` 和 `dispatchedCallIds`：

- `../outside.txt` 的 `insideWorkspace` 为 `false`；
- `escape-link.txt` 的输入字符串看似安全，但解析目标仍在外部；
- 两个 CallId 都没有进入 `tools/execute`；
- outside fixture 未改变；
- outside fixture 内容没有进入 Session transcript。

### 步骤 9：运行自动验收

```bash
pnpm exec vitest run s13_capstone/tests
pnpm exec oxlint s13_capstone/src s13_capstone/tests --deny-warnings
pnpm exec tsc --noEmit
```

根脚本接入后可以改用：

```bash
pnpm test:s13
pnpm check:course
```

### 步骤 10：做一次原创修改

把 Context B 的最终状态从“恢复后编辑”改成你自己的短句，同时修改：

- `createContextBAdapter()` 的 `new_string`；
- `FINAL_COURSE_CONTENT` 的预期 fixture。

重新跑 demo 和测试。这个修改要求你理解“模型调用参数”和“独立磁盘验收”是两条证据，不能只改打印文本。

## 负向实验

### 负向 A：恢复后直接 edit

这是主实验内置的负例，不需要破坏代码。审批允许调用进入 body，但新 Context 的 observation cache 为空，因此结果是：

```text
approval = allowed-once
tools/execute = entered
fs/edit-intent = FS_NOT_OBSERVED
tool/result = error with recovery hint
file = unchanged
```

它说明权限判断与业务 / freshness 判断是两层，不应把“用户批准”理解为“操作必然成功”。

### 负向 B：`../outside.txt`

模型提出完整覆盖外部文件。policy 在 Approval 前发现规范目标越界，直接 deny：

```text
tool/call
→ tools/pre-execute deny
→ tool/result error
```

没有 `approval/asked`，也没有 `tools/execute`。

### 负向 C：workspace 内 symlink 指向外部

`escape-link.txt` 的路径字符串没有 `..`，所以只检查字符串或 `path.resolve()` 的逻辑容易误判。LocalFileSystem resolve 跟随现有 symlink，`contains()` 对规范身份给出 false。

### 安全故障注入

可以临时把 Context B adapter 中的 `B_READ_CALL_ID` 那一步移到 retry edit 之后。此时两次 edit 都没有在新 Context 中观察文件，函数脚本会以 `read-then-retry should succeed` 失败，demo 和行为测试应同时变红。

观察完成后恢复原顺序并复跑。不要通过把真实仓库目录设成 workspace 来测试越界，也不要删除 cleanup。

## 预期观察

demo 的稳定结论是：

```text
S13 PASS 1/3：Context A flush 后，Context B 从同一 JSONL Session 继续 Turn 2
S13 PASS 2/3：恢复 transcript 不恢复 observation cache，read 后重试成功
S13 PASS 3/3：父目录与 symlink 逃逸均在 tool body 前拒绝
```

临时绝对路径每次运行都不同，不应快照具体目录名。需要稳定断言的是 Session cwd 与本次 workspace 相等、CallId / event 顺序、错误码、最终文件内容和清理结果。

## 对照真实源码

以下链接固定到本课程上游 commit，不使用浮动分支或行号：

- [`FileSystem` seam、`resolve` 与 `contains`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs/src/index.ts)
- [`LocalFileSystem` realpath identity 与 mutation](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs-local/src/index.ts)
- [`fs-observation-policy` 的 WeakMap gate](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/fs-observation-policy/src/index.ts)
- [`ToolFs` plugin 组合](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/src/index.ts)
- [`read` 工具与 `fs/observed`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/src/read.ts)
- [`edit` 工具与 `fs/edit-intent`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/fs/tool-fs/src/edit.ts)
- [`ToolRuntime` pre-execute、Approval 与 dispatch pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/tools/src/index.ts)
- [`AgentRegistry.create/resume` 与 `meta.cwd`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/core/agent/src/index.ts)
- [JSONL persistence backend](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence-jsonl/src/index.ts)

阅读顺序建议：先看 `tool-fs/src/edit.ts` 如何发出 `fs/edit-intent`，再看 observation policy 如何决定，最后看 LocalFileSystem 如何原子检查版本。这样不会把工具、policy 和 provider 三层混为一层。

## 验收

本章达到 `Pass` 需要同时满足：

- [ ] 能解释 `LocalFileSystem.cwd` 为什么不是 sandbox；
- [ ] 能从源码指出 Session cwd 怎样进入 ToolFs resolve；
- [ ] Context A / B 使用不同 root Context，JSONL durable prefix 保持一致；
- [ ] 恢复后第一次 edit 的真实错误码是 `FS_NOT_OBSERVED`；
- [ ] read 后 retry edit 成功，真实磁盘内容符合预期；
- [ ] 三次 mutation 各自留下 `allowed-once` 审计；
- [ ] `../outside.txt` 与 symlink escape 都没有进入 `tools/execute`；
- [ ] outside fixture 未改、内容未进入 transcript；
- [ ] Agent、Session 和精确临时根完成清理；
- [ ] demo、行为测试、章节契约、lint 与 typecheck 全部通过；
- [ ] 完成一次原创修改或故障注入，并写下 pass / fix / not-yet 结论。

课程代码通过只证明课程工件成立。学习者仍应亲手完成步骤 1-10 后，再把个人掌握状态标为 `Pass`。

## 教学简化与生产边界

1. **应用层 containment 不是 OS sandbox。** LocalFileSystem 对宿主文件系统本来拥有完整能力；pre-execute 只拦截经过 ToolRuntime 的这些调用。
2. **检查与执行之间存在 TOCTOU 窗口。** 课程 policy resolve 一次，ToolFs body 还会再次 resolve。若同进程或同主机攻击者在两者之间替换 symlink，应用层检查本身不能提供 race-free confinement。对不可信代码应使用真正限制能力的 filesystem backend、进程 / 容器 sandbox 和最小宿主权限。
3. **Approval 不是效果保证。** 它只允许 dispatch；observation、版本、schema、I/O 或取消仍可使工具失败。
4. **观察缓存不持久。** rc.2 resume 后必须重新读取；生产 UI 或模型策略应能理解并恢复 `FS_NOT_OBSERVED`。
5. **Scripted model 不代表真实模型质量。** 真实部署还要评测工具选择、错误恢复、成本、token、超时、provider 网络失败和 prompt injection。
6. **本章只验证 macOS / Linux symlink fixture。** Windows 创建 symlink 可能要求 Developer Mode 或额外权限；若要支持 Windows，应单独设计 junction / symlink fixture 与清理验收。
7. **`compression: none` 是课程选择。** 它方便逐行检查 JSONL，不代表生产存储配置建议。

## 上游观察卡

### 已确认的设计事实

`fs-observation-policy` README 明确把“观察状态不能跨 Session 恢复”列为已知限制。本章给出了 AgentLoop + JSONL + ToolFs 的端到端复现：durable transcript 已恢复，但第一次 mutation 仍得到 `FS_NOT_OBSERVED`。这更适合作为教程和集成测试素材，不应重复提交成“未记录 bug”。

### 可讨论的工程边界

部署若使用 `LocalFileSystem + tools/pre-execute` 自行做 containment，需要显式说明二次 resolve 的 TOCTOU 窗口。若上游未来提供官方应用层 workspace policy 示例，建议示例直接强调它是 dispatch policy，并引导高风险部署改用真正 confining 的 filesystem backend；在没有可复现的上游承诺违背前，本课程不贸然提交 issue。

### 可能形成的开源贡献

- 把本章的 “resume 后 observation cache cold” 精简为上游跨包 integration test；
- 为官方文档补充 Session persistence 与 policy memory 的边界图；
- 如果真实部署发现 workspace containment 的官方组合缺少清晰示例，再提交 docs PR，而不是把课程 policy 宣称为通用安全实现。
