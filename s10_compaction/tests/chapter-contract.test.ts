import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 10 章文档与实现契约', () => {
  it('保留手把手章节结构，且不规定统一时长', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const heading of [
      '## 问题',
      '## 先认识九个基本概念',
      '## 你会交付什么',
      '## 机制图',
      '## 本章边界',
      '## 手把手实验',
      '## 负向实验',
      '## 预期观察',
      '## 对照真实源码',
      '## 验收',
      '## 教学简化与生产边界',
      '## 上游观察卡',
    ]) {
      expect(readme, `缺少章节结构：${heading}`).toContain(heading)
    }

    expect(readme).not.toContain('预计时间')
    expect(readme).toContain('[09 Background jobs](../s09_background_jobs/)')
  })

  it('先解释 compaction 基础词汇，再进入 checkpoint 实验', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '`CompactionEngine`',
      '`BasicCompactionEngine`',
      '`TokenMeter`',
      '`compactIfNeeded()`',
      '`compactNow()`',
      '`compactRegion()`',
      '`CompactionResult`',
      '`surface`',
      '`shadowedSeqs`',
      '`compaction/start`',
      '`compaction/summary`',
      '`compaction/end`',
      '`compactCheckpointSource()`',
      '`isCompactCheckpointSource()`',
      '`surfaceOp: replace`',
      '`ManualCompactionError`',
      '`cancelled`',
      '`session/end-seed`',
      'append-only log',
    ]) {
      expect(readme, `缺少核心概念：${required}`).toContain(required)
    }
    expect(readme).toContain('system prompt、tool schemas')
  })

  it('真实组合负责范围、事务、持久化和恢复，课程只替换 summarize hook', async () => {
    const fake = await readFile(resolve(chapterRoot, 'src/deterministic-fake-summarizer.ts'), 'utf8')
    const harness = await readFile(resolve(chapterRoot, 'src/compaction-harness.ts'), 'utf8')
    const lab = await readFile(resolve(chapterRoot, 'src/compaction-lab.ts'), 'utf8')

    expect(fake).toContain('class DeterministicFakeSummarizerCompactionEngine extends BasicCompactionEngine')
    expect(fake).toContain('protected override async summarize(')
    expect(fake).toContain("FAKE_SUMMARIZER_PROVIDER = 'course-deterministic-fake'")
    expect(fake).not.toContain('llmStreamCall: true')
    expect(fake).not.toContain("@deepseek-ai/dsh-compaction-basic/src/")

    for (const fragment of [
      'mountAgentLoopTestDependencies(ctx)',
      'ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)',
      'ctx.plugin(AgentLoop, { agents: [] })',
      'ctx.plugin(JsonlSessionPersistence',
      'ctx.plugin(TokenMeter)',
      'ctx.plugin(DeterministicFakeSummarizerCompactionEngine, { auto: false })',
    ]) {
      expect(harness).toContain(fragment)
    }
    expect(lab).toContain('ctxA.compaction.compactNow(')
    expect(lab).toContain('resumeCompactionAgent(ctxB, SUCCESS_SESSION_ID)')
    expect(lab).toContain('resumeCompactionAgent(ctxB, FAILURE_SESSION_ID)')
    expect(`${harness}\n${lab}`).not.toMatch(/class\s+(?:Mock|Fake)(?:Agent|Session|TokenMeter)/)
  })

  it('记录 published src export 与 subclass hook 类型入口的上游贡献候选', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '已发现的上游贡献候选',
      '`SummarizationInput`',
      '`SummaryResult`',
      '`ERR_MODULE_NOT_FOUND`',
      '`./summarizer` subpath',
      'packaging / public typing 缺口',
    ]) {
      expect(readme).toContain(required)
    }
  })

  it('正向验证 durable replacement，负向验证 failed bracket 与 surface 不变', async () => {
    const lab = await readFile(resolve(chapterRoot, 'src/compaction-lab.ts'), 'utf8')
    const tests = await readFile(resolve(chapterRoot, 'tests/compaction.test.ts'), 'utf8')
    const source = `${lab}\n${tests}`

    for (const required of [
      'compaction.shadowedSeqs',
      'checkpointSourceRecognized',
      'shadowedEventsStillInRawLog',
      'durableEventRecords',
      'resumedDurablePrefix',
      'resumedMessages',
      "seedMarker?.type !== 'session/end-seed'",
      'engine.failNextSummary()',
      "errorCode).toBe('summary')",
      'hasSummaryEvent',
      'hasCheckpoint',
    ]) {
      expect(source).toContain(required)
    }
  })

  it('固定公开包版本与上游 commit，源码链接不用浮动分支或行号', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const dependency of [
      '@deepseek-ai/dsh-compaction@0.1.1-rc.2',
      '@deepseek-ai/dsh-compaction-basic@0.1.1-rc.2',
      '@deepseek-ai/dsh-token-meter@0.1.1-rc.2',
      '@deepseek-ai/dsh-session-persistence-jsonl@0.1.1-rc.2',
      '@deepseek-ai/dsh-agent-loop@0.1.1-rc.2',
      '@deepseek-ai/dsh-session@0.1.1-rc.2',
    ]) {
      expect(readme).toContain(dependency)
    }

    expect(readme).toContain('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
    expect(readme).not.toMatch(/github\.com\/deepseek-ai\/deepseek-harness\/blob\/(?:main|master)\//)
    expect(readme).not.toMatch(/github\.com\/deepseek-ai\/deepseek-harness\/blob\/[^)]+#L\d+/)
  })

  it('README 的本地文件链接都能解析', async () => {
    const readmePath = resolve(chapterRoot, 'README.md')
    const readme = await readFile(readmePath, 'utf8')
    const missingLinks: string[] = []

    for (const match of readme.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]?.trim()
      if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue

      const pathWithoutAnchor = decodeURIComponent(target.split('#', 1)[0] ?? '')
      if (!pathWithoutAnchor) continue

      try {
        await access(resolve(dirname(readmePath), pathWithoutAnchor))
      } catch {
        missingLinks.push(target)
      }
    }

    expect(missingLinks).toEqual([])
  })
})
