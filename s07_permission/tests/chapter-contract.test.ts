import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 7 章文档与实现契约', () => {
  it('保留手把手结构，不规定统一学习时长', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const heading of [
      '## 问题',
      '## 先认识八个基本概念',
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
    expect(readme).toContain('[06 无 Key AgentLoop](../s06_keyless_agent_loop/)')
  })

  it('先解释 Permission、Approval 与 sandbox 的边界', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '`tools/pre-execute`',
      '`PreToolDecision`',
      '`next()`',
      '`allow`',
      '`ask`',
      '`deny`',
      '`ApprovalService`',
      '`allowed-once`',
      '`rejected`',
      '`unavailable`',
      '`ApprovalPolicy`',
      '`approval/asked`',
      '`approval/decided`',
      'open turn',
      'fail closed',
      'Approval 不等于 sandbox enforcement',
    ]) {
      expect(readme, `缺少核心概念：${required}`).toContain(required)
    }
  })

  it('显式组合真实 AgentLoop、ApprovalService 与 S06 adapter', async () => {
    const lab = await readFile(resolve(chapterRoot, 'src/permission-lab.ts'), 'utf8')

    expect(lab).toContain('mountAgentLoopTestDependencies(ctx)')
    expect(lab).toContain('ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)')
    expect(lab).toContain('ctx.plugin(ApprovalService, { policy: approvalPolicy })')
    expect(lab).toContain('ctx.plugin(createCourseWriteToolPlugin(workspace))')
    expect(lab).toContain('ctx.plugin(AgentLoop, { agents: [] })')
    expect(lab).toContain('../../s06_keyless_agent_loop/src/scripted-llm.ts')
    expect(lab).toContain("handle.agent.ctx.on('approval/request'")
    expect(lab).toContain('handle.agent.followup(')
    expect(lab).toContain('handle.agent.whenIdle()')
    expect(lab).not.toMatch(/class\s+(?:Mock|Fake)(?:Agent|Session|Approval)/)
  })

  it('policy matrix 正确，安全路径明确通过 next 委托', async () => {
    const policy = await readFile(resolve(chapterRoot, 'src/permission-policy.ts'), 'utf8')

    expect(policy).toContain("case 'draft':")
    expect(policy).toContain("decision: 'allow-via-next'")
    expect(policy).toContain('return next()')
    expect(policy).toContain("case 'publish':")
    expect(policy).toContain("return { kind: 'ask', reason: PUBLISH_APPROVAL_REASON }")
    expect(policy).toContain("case 'system':")
    expect(policy).toContain("return { kind: 'deny', reason: SYSTEM_DENIAL_REASON }")
  })

  it('demo 全自动作答且包含 no-answerer 与 never fail-closed 探针', async () => {
    const demo = await readFile(resolve(chapterRoot, 'src/demo.ts'), 'utf8')
    const lab = await readFile(resolve(chapterRoot, 'src/permission-lab.ts'), 'utf8')
    const source = `${demo}\n${lab}`

    expect(source).toContain("['allowed-once', 'rejected']")
    expect(source).toContain('runNoAnswererScenario')
    expect(source).toContain('runNeverPolicyScenario')
    expect(source).not.toMatch(/readline|process\.stdin|prompt\(/)
  })

  it('固定公开包版本与上游 commit，链接不使用浮动分支或行号', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const dependency of [
      '@deepseek-ai/dsh-agent-loop@0.1.1-rc.2',
      '@deepseek-ai/dsh-agent-loop-testkit@0.1.1-rc.2',
      '@deepseek-ai/dsh-session@0.1.1-rc.2',
      '@deepseek-ai/dsh-tools@0.1.1-rc.2',
      '@deepseek-ai/dsh-user-approval@0.1.1-rc.2',
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
