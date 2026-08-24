# Notes: S13 keyless mini coding harness

## Sources

- 固定上游：`deepseek-ai/deepseek-harness`，commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- 既有课程：`s06_keyless_agent_loop/`、`s07_permission/`、`s08_jsonl_persistence/`

## Findings

### 直接依赖与公开导出

- `@deepseek-ai/dsh-fs@0.1.1-rc.2`：`ctx.fs` seam、`resolve`、`contains` 和 `FsError` 词汇。
- `@deepseek-ai/dsh-fs-local@0.1.1-rc.2`：`LocalFileSystem`；`cwd` 只是默认解析基准，不是 sandbox。
- `@deepseek-ai/dsh-fs-observation-policy@0.1.1-rc.2`：event-only plugin；用 `WeakMap<session, target observations>` 保存进程内观察状态。
- `@deepseek-ai/dsh-tool-fs@0.1.1-rc.2`：注册 `read` / `write` / `edit`；没有 attachment service 时不注册 `read_image`。

### 工具与 observation policy

- `read` 在 `stat + readText/streamText` 成功后发出 `fs/observed`。
- `edit` 先经过 `fs/edit-intent`；新 Context 中没有该 Session 对象的观察记录时抛 `FS_NOT_OBSERVED`，工具层追加 `read the file, then retry`。
- 观察 owner 是 `exec.agent.session` 的对象身份；JSONL 只恢复 transcript/header，不会序列化这个 `WeakMap`。
- `write` / `edit` 成功后会更新观察版本；因此同一 Session 对象在一次 Context 生命周期中重试可继续。

### 路径与审批

- `LocalFileSystem.resolve` 对存在路径使用 realpath identity；`contains(parent, child)` 在规范身份上判断相等或后代，因此 symlink 指向 workspace 外时会失败。
- `Session.header.cwd` 是 `ToolFs` 解析相对路径的基准；创建 Session 时必须通过 `meta.cwd` 写入绝对 workspace，resume 后再检查其原样恢复。
- `tools/pre-execute` 位于 tool body 之前；`ask` 通过 `ApprovalService` 解析为一次性 `allowed-once` 后才进入 `tools/execute`。
- 审批 answerer 必须注册在 `handle.agent.ctx`，避免全局 listener 回答其它 Agent。

### 课程轨迹

1. Context A：`read lesson.md` → `edit`（一次审批）→ 最终文本动态读取真实 edit result → flush/dispose。
2. Context B：resume → 直接 `edit`（重新审批，但 `FS_NOT_OBSERVED`）→ `read` → 同一 edit 重试（再次审批并成功）。
3. Context B：`write ../outside.txt` 与 `read escape-link.txt` 都在 pre-execute containment policy 阶段拒绝；不进入 `tools/execute`，不修改或读取 outside fixture。
4. 最终文本通过 S06 `ScriptedLlmAdapter` 的函数脚本现场读取真实 `tool-result`，不写死执行结论。

## Validation

- 正向：Context A / B 两次 flush 后，物理 JSONL 事件分别等于各自 live log；Turn 为 `1 → 2`。
- 观察边界：Context B 首次 edit 已获 `allowed-once` 且进入 `tools/execute`，随后真实返回 `FS_NOT_OBSERVED`；read 后 retry 重新审批并成功。
- 路径边界：`../outside.txt` 在 ask 前 deny；symlink resolve 到外部后同样 deny。两者均未进入 `tools/execute`，外部 fixture 未改且内容未进入 transcript。
- 自动验收：2 files / 17 tests、lint、typecheck、demo、diff / whitespace scan 全部通过。
- 故障注入：把 Context B 的 read 临时改向外部路径后，demo 确定性退出 1；恢复后全套章节验证重新通过。

## Upstream Judgment

- resume 后 observation cache cold 是 rc.2 已文档化限制，本章提供的是跨包端到端复现，不重复作为未知 bug 上报。
- `resolve + contains` 的课程 policy 会在 ToolFs body 再次 resolve 前留下 TOCTOU 窗口；这是应用层 dispatch policy 的边界。若形成上游贡献，应优先补文档 / 示例并引导使用 confining backend，不把它包装成通用安全实现。
