# 上游基线与兼容性

最后验证：2026-08-24

## 固定基线

| 项目 | 值 |
| --- | --- |
| 上游 | `https://github.com/deepseek-ai/deepseek-harness` |
| 版本 | `0.1.1-rc.2` |
| commit | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` |
| 默认分支 | `master` |
| 上游许可证 | MIT（个别 vendored/native 子目录可能不同） |
| 课程依赖 | `@deepseek-ai/cordis@4.0.1` |

DeepSeek Harness 仍处于 developer preview，可能自由重命名或产生破坏性变化。本课程的结论只对表中基线负责。

## 第 1 章源码锚点

- [Cordis 生命周期官方教程](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/docs/cordis-tutorial/02-lifecycle-and-effects.zh.md)
- [`Context` 与根 fiber](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/context.ts)
- [`Fiber.effect()` 与 `Fiber.dispose()`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/fiber.ts)
- [Cordis 包定义](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/package.json)

## 兼容策略

1. 课程运行不要求 clone 上游源码。
2. 源码研究使用固定 commit permalink，不使用浮动 `master` 行号。
3. 升级依赖前先运行 `pnpm check:course`，再人工复核源码锚点。
4. 若上游 API 变化，先记录兼容性结果，再决定升级课程基线或保留旧分支。
5. 不把上游 `vendor/`、构建产物或整文件复制进本仓库。

## 环境说明

DeepSeek Harness 整仓要求 Node `^22.19.0 || >=24.0.0` 和 pnpm `11.7.0`。课程沿用这条基线，避免前几章能运行、后续进入真实 DSH 包时再被迫切换环境。
