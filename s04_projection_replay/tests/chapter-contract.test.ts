import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 4 章文档与实现契约', () => {
  it('保留手把手章节必需的教学环节，且不规定统一时长', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const heading of [
      '## 问题',
      '## 先认识八个基本概念',
      '## 你会交付什么',
      '## 机制图',
      '## 本章边界',
      '## 手把手实验',
      '## 负向实验',
      '## 对照真实源码',
      '## 验收',
      '## 教学简化与生产差异',
      '## 上游观察卡',
    ]) {
      expect(readme, `缺少章节结构：${heading}`).toContain(heading)
    }

    expect(readme).not.toContain('预计时间')
  })

  it('先解释基础 API，再进入三路一致性与 seed marker', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '`ProjectionDefinition`',
      '`key`',
      '`init`',
      '`apply`',
      '`stateSchema`',
      '`wire.view`',
      '`register`',
      '`snapshot`',
      '`asOfSeq`',
      '`onChanged`',
      '@deepseek-ai/dsh-session-projection',
      'live incremental',
      'lazy full fold',
      'manual full fold',
      'seed replay',
      'session/end-seed',
      'Object.is',
      'whole value',
      '`todo/write`',
    ]) {
      expect(readme, `缺少核心契约：${required}`).toContain(required)
    }
  })

  it('直接组合公开包，而不是在课程内重写 projection registry', async () => {
    const lab = await readFile(resolve(chapterRoot, 'src/projection-lab.ts'), 'utf8')
    const domain = await readFile(resolve(chapterRoot, 'src/todo-domain.ts'), 'utf8')
    const source = `${lab}\n${domain}`

    expect(source).toContain("from '@deepseek-ai/dsh-session-projection'")
    expect(source).toContain('manualFullFold(todoProjection, live.events)')
    expect(source).toContain("event.type !== 'todo/write'")
    expect(source).not.toContain("declare module '@deepseek-ai/dsh-session/types'")
    expect(source).not.toContain('course/board/set')
    expect(source).not.toContain('course/noise')
    expect(source).not.toMatch(/class\s+\w*ProjectionRegistry/)
    expect(source).not.toMatch(/sessionProjections\.(?:checkpoint|restore)\s*\(/)
  })

  it('固定上游文件链接不携带易漂移行号', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

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
