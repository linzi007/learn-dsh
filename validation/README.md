# 验证记录

每次章节从 `planned` 进入 `ready`，在这里保存一份验证记录，至少包含：

- 日期、OS、Node、pnpm 和上游基线。
- 从 clean clone 视角执行的命令。
- demo、typecheck、test 的结果摘要。
- `Pass / Fix / Not yet` 结论。
- 已知限制和下一次需要复核的风险。

验证记录不提交 API Key、真实会话日志、未脱敏路径或用户数据。

## 当前记录

- [S01：Plugin、Fiber 与 Effect](2026-08-24-s01.md)
- [v0.2：Service → Session → Projection](2026-08-24-v02.md)
- [v0.3：Tool → AgentLoop → Permission](2026-08-24-v03.md)
- [v0.4：Persistence → Jobs → Compaction](2026-08-24-v04.md)
- [v0.5：MCP → Subagent → Capstone](2026-08-24-v05.md)
- [v0.6：真实 DeepSeek + Keyless 双轨](2026-08-24-v06.md)
