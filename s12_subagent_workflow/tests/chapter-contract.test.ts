import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 12 章文档与实现契约', () => {
  it('保留手把手章节结构，且不规定统一时长', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const heading of [
      '## 问题',
      '## 先认识十一个基本概念',
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
    expect(readme).toContain('[11 MCP bridge](../s11_mcp_bridge/)')
    expect(readme).toContain('[13 综合项目](../s13_capstone/)')
  })

  it('先解释 Subagent、Workflow、结构化输出、事件与 holder 所有权', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '`parent Agent`',
      '`SubagentRuntime`',
      'provider',
      '`spawn-in-process`',
      '`plain child`',
      '`structured child`',
      '`structured_output`',
      '`WorkerThreadWorkflowEngine`',
      '`agent()`',
      '`phase()`',
      '`log()`',
      '`workflow/start`',
      '`workflow/end`',
      '`workflow/agent-start`',
      '`workflow/agent-end`',
      '`subagent/start`',
      '`subagent/end`',
      '`WorkflowRun`',
      '`dispose()`',
      '`maxTotalAgents`',
      '`null`',
    ]) {
      expect(readme, `缺少核心概念：${required}`).toContain(required)
    }
  })

  it('明确唯一 fake、spawn 上下文边界与 worker/vm 非安全沙箱', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')
    const harness = await readFile(resolve(chapterRoot, 'src/workflow-harness.ts'), 'utf8')
    const lab = await readFile(resolve(chapterRoot, 'src/subagent-workflow-lab.ts'), 'utf8')

    expect(readme).toContain('唯一替身')
    expect(readme).toContain('`ScriptedLlmAdapter`')
    expect(readme).toContain('不复制 parent transcript')
    expect(readme).toContain('不是安全沙箱')
    expect(readme).toContain('必须调用 `dispose()`')
    expect(readme).toContain('provider 在 `start()` Promise 兑现前拥有创建事务')
    expect(readme).toContain('caller/holder-owned')
    expect(readme).toContain('`disposeGraceMs` 的有界窗口')
    expect(readme).toContain('权限')

    expect(harness).toContain("from '@deepseek-ai/dsh-subagent'")
    expect(harness).toContain("from '@deepseek-ai/dsh-subagent-spawn-in-process'")
    expect(harness).toContain("from '@deepseek-ai/dsh-workflow-worker-thread'")
    expect(harness).toContain('ctx.plugin(AgentLoop')
    expect(harness).toContain('ctx.plugin(SubagentRuntime)')
    expect(harness).toContain('ctx.plugin(spawnInProcess')
    expect(harness).toContain('ctx.plugin(WorkerThreadWorkflowEngine')
    expect(lab).toContain("from '../../s06_keyless_agent_loop/src/scripted-llm.ts'")
    expect(`${harness}\n${lab}`).not.toMatch(/from '@deepseek-ai\/[^']+\/src\//)
    expect(`${harness}\n${lab}`).not.toMatch(/class\s+\w*(?:SubagentRuntime|WorkflowEngine|AgentLoop)/)
  })

  it('固定公开包版本与上游 commit，源码链接不用浮动分支或行号', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const dependency of [
      '@deepseek-ai/dsh-subagent@0.1.1-rc.2',
      '@deepseek-ai/dsh-subagent-in-process-driver@0.1.1-rc.2',
      '@deepseek-ai/dsh-subagent-spawn-in-process@0.1.1-rc.2',
      '@deepseek-ai/dsh-workflow@0.1.1-rc.2',
      '@deepseek-ai/dsh-workflow-worker-thread@0.1.1-rc.2',
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
