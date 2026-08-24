# 第三方依赖与引用

## `@deepseek-ai/cordis`

- 版本：`4.0.1`
- 来源：DeepSeek Harness 仓库的 `vendor/cordis`
- Copyright (c) 2021-present Shigma
- 许可证：MIT
- 许可证原文：[固定基线的 `vendor/cordis/LICENSE`](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/LICENSE)
- 用途：第 1 章直接调用其公开 API，演示真实 plugin / effect / fiber 生命周期。

本仓库只声明 NPM 依赖，没有复制 Cordis 或 DeepSeek Harness 的实现文件，也没有把依赖代码打包进仓库。课程文字对上游机制进行原创解释，并通过 `UPSTREAM.md` 中的固定 commit 链接引用来源。若未来发布 bundle、桌面应用或静态制品，必须随产物携带所含第三方软件要求的完整许可证。

`pnpm-lock.yaml` 用于固定依赖版本和完整性哈希；许可证的权威来源是各安装包自带的 `LICENSE` 和 package metadata。
