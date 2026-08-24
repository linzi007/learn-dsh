import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('第 3 章文档契约', () => {
  it('保留手把手章节必需的教学环节', async () => {
    const readmeUrl = new URL('../README.md', import.meta.url)
    const readme = await readFile(readmeUrl, 'utf8')

    for (const heading of [
      '## 问题',
      '## 先认识六个基本概念',
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
    expect(readme).toContain('[02 Service seam](../s02_service_seam/)')
    expect(readme).toContain('[04 Projection replay](../s04_projection_replay/)')
  })

  it('明确使用真实固定版本并引用固定上游 commit', async () => {
    const readmeUrl = new URL('../README.md', import.meta.url)
    const readme = await readFile(readmeUrl, 'utf8')

    expect(readme).toContain('@deepseek-ai/dsh-session@0.1.1-rc.2')
    expect(readme).toContain('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
    expect(readme).not.toMatch(/github\.com\/deepseek-ai\/deepseek-harness\/blob\/(?:main|master)\//)
  })

  it('实验调用真实 Session 而不是重写教学实现', async () => {
    const labUrl = new URL('../src/session-lab.ts', import.meta.url)
    const lab = await readFile(labUrl, 'utf8')

    expect(lab).toContain("from '@deepseek-ai/dsh-session'")
    expect(lab).not.toMatch(/class\s+Session\b/)
  })
})
