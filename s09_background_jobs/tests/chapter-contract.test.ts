import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 9 章文档与实现契约', () => {
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
    expect(readme).toContain('[08 JSONL persistence](../s08_jsonl_persistence/)')
    expect(readme).toContain('[10 Compaction](../s10_compaction/)')
  })

  it('先解释 Job runtime 的基本角色，再进入生命周期实验', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '`JobRegistry`',
      '`LocalJobRegistry`',
      'Service Provider',
      'producer',
      '`JobStart`',
      '`JobHooks`',
      '`JobSnapshot`',
      '`attachController()`',
      'owner',
      '`reported`',
      '`running`',
      '`stopping`',
      '`completed`',
      '`killed`',
      '`failed`',
      '`job_output`',
      '`job_list`',
      '`job_kill`',
      'AgentLoop',
    ]) {
      expect(readme, `缺少核心概念：${required}`).toContain(required)
    }
    expect(readme).toContain('producer.readOutput()')
    expect(readme).toContain('orphan work')
  })

  it('只组合公开 Provider/API，课程 controller 不承担 producer 职责', async () => {
    const lab = await readFile(resolve(chapterRoot, 'src/background-jobs-lab.ts'), 'utf8')
    const producer = await readFile(resolve(chapterRoot, 'src/deterministic-job.ts'), 'utf8')
    const agent = await readFile(resolve(chapterRoot, 'src/lifecycle-agent.ts'), 'utf8')

    expect(lab).toContain("from '@deepseek-ai/dsh-jobs-local'")
    expect(lab).toContain('root.plugin(AgentRegistry)')
    expect(lab).toContain('root.plugin(LocalJobRegistry)')
    expect(lab).toContain("inject: ['jobs']")
    expect(lab).toContain("ctx.jobs.attachController('s09-course-lab')")
    expect(lab.match(/ctx\.jobs\.attachController\(/g)).toHaveLength(1)
    expect(producer).toContain("interface JobKindMap")
    expect(producer).toContain("course: 'course'")
    expect(producer).toContain('run: () => this.start()')
    expect(agent).toContain('Session.create(id)')
    expect(agent).toContain('new Inbox(session')
    expect(agent).toContain('root.agents.register(agent)')

    expect(`${lab}\n${producer}`).not.toMatch(/class\s+\w*(?:JobRegistry|Scheduler|Queue)/)
    expect(`${lab}\n${producer}`).not.toContain("from '@deepseek-ai/dsh-tool-jobs'")
    expect(`${lab}\n${producer}`).not.toContain("from '@deepseek-ai/dsh-agent-loop'")
    expect(`${lab}\n${producer}`).not.toContain('setTimeout(')
    expect(`${lab}\n${producer}`).not.toContain('/src/')
  })

  it('固定公开包版本与上游 commit，源码链接不用浮动分支或行号', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const dependency of [
      '@deepseek-ai/dsh-jobs@0.1.1-rc.2',
      '@deepseek-ai/dsh-jobs-local@0.1.1-rc.2',
      '@deepseek-ai/dsh-agent@0.1.1-rc.2',
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
