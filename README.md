# Learn DSH

用可运行、可观察、可验收的实验，逐步学习 DeepSeek Harness 的非官方中文课程。

> [!IMPORTANT]
> 这是社区学习项目，与 DeepSeek 或 DeepSeek Harness 团队没有隶属、合作或背书关系。项目名使用[上游品牌指南](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/BRAND_GUIDELINES.zh.md)建议的缩写 `DSH`。

## 为什么做这个项目

DeepSeek Harness 已经提供 Cordis 入门教程，但从“理解插件”到“构造带 session、tool、permission、persistence、MCP 和 subagent 的 Harness”之间，仍有很长的工程路径。

本课程不追求快速抄出一个大而全的 Agent。每一章只增加一个机制，并完成这个闭环：

```text
提出问题 → 最小机制 → 分步代码 → 运行实验
    → 观察证据 → 失败用例 → 自动验收 → 映射生产源码
```

## 当前进度

版本：`v0.6`。

| 章节 | 状态 | 核心产物 | 是否需要 API Key |
| --- | --- | --- | --- |
| [01 Plugin、Fiber 与 Effect](s01_lifecycle_microscope/) | 可学习 | 基本概念、生命周期与资源泄漏探针 | 否 |
| [02 Service seam](s02_service_seam/) | 可学习 | 可替换 Provider / Consumer 与缺失 `inject` 负例 | 否 |
| [03 Append-only session](s03_append_only_session/) | 可学习 | 连续、不可改写且失败不污染的事件日志 | 否 |
| [04 Projection 与 replay](s04_projection_replay/) | 可学习 | 增量、全量 fold 与 seed replay 一致性 | 否 |
| [05 Tool contract](s05_tool_contract/) | 可学习 | schema、参数、canonical value 与 renderer 闭环 | 否 |
| [06 AgentLoop 双轨](s06_keyless_agent_loop/) | 可学习 | 默认真实 DeepSeek tool-use + keyless 事件显微镜 | 默认真实需要；CI 否 |
| [07 Permission policy 与一次性 Approval](s07_permission/) | 可学习 | 可组合 policy、单次确认、审计与 fail-closed | 否 |
| [08 JSONL persistence](s08_jsonl_persistence/) | 可学习 | 双 Context 恢复、torn tail 修复与 committed corruption 拒绝 | 否 |
| [09 Background jobs](s09_background_jobs/) | 可学习 | 增量读取、owner 隔离、取消与生命周期清理 | 否 |
| [10 Compaction checkpoint](s10_compaction/) | 可学习 | durable replacement、失败事务与 JSONL resume | 否 |
| [11 MCP bridge](s11_mcp_bridge/) | 可学习 | 真实 stdio 协议、本地 fixture、错误映射与子进程清理 | 否 |
| [12 Subagent 与 Worker Workflow](s12_subagent_workflow/) | 可学习 | plain / structured child、双层事件、失败与有界清理 | 否 |
| [13 Keyless Mini Coding Harness](s13_capstone/) | 可学习 | 文件工具、观察策略、一次性审批、路径边界与恢复 | 否 |

“可学习”表示本地课程工件已具备 README、assert demo、负向用例和自动测试；不代表学习者已经亲手掌握，也不代表尚未推送的版本已有远程 CI 证据。

## 开始学习

前置环境：

- Node.js `^22.19.0` 或 `>=24.0.0`，推荐 Node 24（Node 23 不在支持范围）
- pnpm `11.7.0`（`packageManager` 已固定）
- Git `2.26+`

安装依赖，并先准备第 6 章会用到的本机 DeepSeek 配置：

```bash
corepack pnpm install
cp -n .env.example .env
chmod 600 .env
```

`cp -n` 在 `.env` 已存在时不会覆盖它。

在 `.env` 中填写：

```dotenv
DEEPSEEK_API_KEY=你的本机 Key
DEEPSEEK_MODEL=deepseek-v4-flash
DSH_HOME=.dsh
```

`DEEPSEEK_MODEL` 是 Learn DSH 的课程约定，不是上游标准环境变量；课程会把它填入 `AgentOptions.model`。Key 可在 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys)管理，真实费用以[官方定价页](https://api-docs.deepseek.com/quick_start/pricing/)为准。

`.env` 与 `.dsh/` 已被 Git 忽略，绝不要把 Key 放进源码、提交、Issue 或日志。官方默认端点也会收到 Key、Prompt、工具 schema / 结果与 Harness 会话标识；`DEEPSEEK_BASE_URL` 只是把接收方改成你指定的网关，因此只能配置可信端点。当前 S06 只有无法读取文件的 `course_add`；未来接入 filesystem / shell 工具时，应把 Secret 移出 Agent 可访问工作区，改用 credentials service 或平台 Secret 注入。

现在运行第 1 章：

```bash
corepack pnpm demo:s01
corepack pnpm test:s01
```

S01-S05 不会访问模型，也不会产生 API 费用；到 S06 才第一次使用这份配置。

继续运行其余可学习章节：

```bash
corepack pnpm demo:s02 && corepack pnpm test:s02
corepack pnpm demo:s03 && corepack pnpm test:s03
corepack pnpm demo:s04 && corepack pnpm test:s04
corepack pnpm demo:s05 && corepack pnpm test:s05
corepack pnpm demo:s06          # 默认：真实 DeepSeek，会联网并产生少量费用
corepack pnpm demo:s06:keyless  # 固定实验：不联网
corepack pnpm test:s06          # 自动验收：不联网
corepack pnpm demo:s07 && corepack pnpm test:s07
corepack pnpm demo:s08 && corepack pnpm test:s08
corepack pnpm demo:s09 && corepack pnpm test:s09
corepack pnpm demo:s10 && corepack pnpm test:s10
corepack pnpm demo:s11 && corepack pnpm test:s11
corepack pnpm demo:s12 && corepack pnpm test:s12
corepack pnpm demo:s13 && corepack pnpm test:s13
```

运行全课程检查：

```bash
corepack pnpm check:course
corepack pnpm demo:all
```

`check:course` 与 `demo:all` 始终使用 keyless 路径，不使用 Key、不访问模型；这是贡献者与 CI 的可重复验收。学习者直接运行 `demo:s06` 时则默认走官方 DeepSeek adapter，真实观察 provider、tool-use、usage 和错误语义。

两条证据不能互相冒充：keyless 通过证明 AgentLoop plumbing 可重复，真实 demo 通过才证明当前 Key、模型、网络和 tool-use 确实可用。真实实验关闭 thinking、限制每次输出 512 token、每 Turn 最多 3 个 Step，仍可能产生费用，也仍受额度与网络影响。

## 学习方式

不要只读 README：

1. 先运行 demo，记录你看到的事件顺序。
2. 阅读本章机制图和最小代码。
3. 主动制造 README 指定的错误。
4. 运行测试，让失败信息证明你的理解是否正确。
5. 恢复实现，通过 `Pass / Fix / Not yet` 验收表。
6. 填写“上游观察卡”，把可复现问题沉淀成课程改进、插件或 Discussion。

## 与上游的关系

课程当前固定 DeepSeek Harness `0.1.1-rc.2` / commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。版本、源码锚点和兼容边界见 [UPSTREAM.md](UPSTREAM.md)。

上游目前不接受外部 PR，Issues 也处于关闭状态；官方鼓励社区插件、博客、操作指南和 GitHub Discussions。因此，课程本身和后续原创插件就是当前可落地的生态贡献。具体分流规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 设计原则

- 中文优先；当前不维护翻译和 Web。
- 一章只讲一个核心机制，不规定统一学习时长，以 runnable artifact、负向用例和验收结果作为完成边界。
- 每章至少一个自动测试和一个负向用例。
- 教学实现、mock 与真实生产实现明确分层。
- 不镜像上游源码，只引用固定 commit。
- 先保证纵向切片完整，再增加章节数量。

## License

本项目原创代码和文档使用 [MIT License](LICENSE)。第三方依赖与引用见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
