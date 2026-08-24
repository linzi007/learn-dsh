import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 6 章文档与实现契约', () => {
  it('保留手把手教学结构，且不规定统一时长', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const heading of [
      '## 问题',
      '## 先认识五个基本概念',
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
    expect(readme).toContain('[05 Tool contract](../s05_tool_contract/)')
    expect(readme).toContain('[07 Permission](../s07_permission/)')
  })

  it('先解释 AgentLoop 基本词汇，再进入工具闭环', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '`Agent`',
      '`AgentHandle`',
      '`Turn`',
      '`Step`',
      '`LlmAdapter`',
      '`GenerateOptions`',
      '`StreamChunk`',
      '`followup()`',
      '`whenIdle()`',
      '`tool/call`',
      '`tool/result`',
      '`CallId`',
      '`sourceEventSeqs`',
      '`maxStepsPerTurn`',
      'append-only Session',
    ]) {
      expect(readme, `缺少核心概念：${required}`).toContain(required)
    }
  })

  it('只替换 LLM adapter，并直接复用 S05 的正式工具 Plugin', async () => {
    const adapter = await readFile(resolve(chapterRoot, 'src/scripted-llm.ts'), 'utf8')
    const harness = await readFile(resolve(chapterRoot, 'src/agent-harness.ts'), 'utf8')
    const lab = await readFile(resolve(chapterRoot, 'src/loop-lab.ts'), 'utf8')
    const source = `${adapter}\n${harness}\n${lab}`

    expect(adapter).toContain('class ScriptedLlmAdapter extends LlmAdapter')
    expect(harness).toContain('mountAgentLoopTestDependencies(ctx)')
    expect(harness).toContain("ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)")
    expect(harness).toContain('ctx.plugin(courseAddToolPlugin)')
    expect(harness).toContain('ctx.plugin(AgentLoop, { agents: [] })')
    expect(harness).toContain('ctx.agents.create({')
    expect(harness).toContain('../../s05_tool_contract/src/course-add-tool.ts')
    expect(source).not.toContain('ctx.agentLoop.create(')
    expect(source).not.toMatch(/class\s+(?:Mock|Fake)(?:Agent|Session|ToolRuntime)/)
    expect(source).not.toMatch(/function\s+executeCourseAdd/)
  })

  it('第二次 script step 读取真实结果，步骤预算明确是课程 policy', async () => {
    const harness = await readFile(resolve(chapterRoot, 'src/agent-harness.ts'), 'utf8')
    const lab = await readFile(resolve(chapterRoot, 'src/loop-lab.ts'), 'utf8')

    expect(lab).toContain('findToolResult(request, POSITIVE_CALL_ID)')
    expect(lab).toContain('renderedTextOf(result)')
    expect(lab).toContain('handle.agent.followup(')
    expect(lab).toContain('handle.agent.whenIdle()')
    expect(harness).toContain("ctx.on('agent/pre-step'")
    expect(harness).toContain('step > maxStepsPerTurn')
    expect(harness).toContain("Promise.resolve({ kind: 'reject' })")
  })

  it('固定公开包版本与上游 commit，链接不使用浮动分支或行号', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const dependency of [
      '@deepseek-ai/dsh-agent@0.1.1-rc.2',
      '@deepseek-ai/dsh-agent-loop@0.1.1-rc.2',
      '@deepseek-ai/dsh-agent-loop-testkit@0.1.1-rc.2',
      '@deepseek-ai/dsh-llm@0.1.1-rc.2',
      '@deepseek-ai/dsh-session@0.1.1-rc.2',
      '@deepseek-ai/dsh-tools@0.1.1-rc.2',
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
