import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('第 1 章文档契约', () => {
  it('保留手把手章节必需的教学环节', async () => {
    const readmeUrl = new URL('../README.md', import.meta.url)
    const readme = await readFile(readmeUrl, 'utf8')

    for (const heading of [
      '## 先认识五个基本概念',
      '## 你会交付什么',
      '## 机制图',
      '## 手把手实验',
      '## 负向实验',
      '## 验收',
      '## 教学简化与生产差异',
      '## 上游观察卡',
    ]) {
      expect(readme, `缺少章节结构：${heading}`).toContain(heading)
    }
  })
})
