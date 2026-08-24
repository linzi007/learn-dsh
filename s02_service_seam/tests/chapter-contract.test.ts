import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 2 章文档与实现契约', () => {
  it('保留手把手章节环节，且不规定统一时长', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const heading of [
      '## 问题',
      '## 先认识七个基本概念',
      '## 你会交付什么',
      '## 机制图',
      '## 本章边界',
      '## 手把手实验',
      '## 负向实验',
      '## 预期观察',
      '## 对照真实源码',
      '## 验收',
      '## 教学简化与生产差异',
      '## 上游观察卡',
    ]) {
      expect(readme, `缺少章节结构：${heading}`).toContain(heading)
    }
    expect(readme).not.toContain('预计时间')
  })

  it('明确 Definition、Provider、Consumer、Service 与 inject 的关系', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const term of [
      'Service Definition',
      'Provider',
      'Consumer',
      'Service',
      '`inject`',
      'PENDING',
      'declaration merging',
      '`ctx.get()`',
    ]) {
      expect(readme, `缺少基础概念：${term}`).toContain(term)
    }
  })

  it('实现稳定 Definition、两个 Provider class 与不绑定实现的 Consumer', async () => {
    const source = await readFile(resolve(chapterRoot, 'src/service-lab.ts'), 'utf8')

    expect(source).toContain("from '@deepseek-ai/cordis'")
    expect(source).toMatch(/abstract class GreeterDefinition extends Service/)
    expect(source).toMatch(/courseGreeter:\s*GreeterDefinition/)
    expect(source.match(/extends GreeterDefinition/g)).toHaveLength(2)
    const consumerSource = source.slice(
      source.indexOf('export function createGreeterConsumer'),
      source.indexOf('function takeCheckpoint'),
    )
    expect(consumerSource).not.toContain('FriendlyGreeterProvider')
    expect(consumerSource).not.toContain('FormalGreeterProvider')
    expect(source).not.toMatch(/class\s+Context\b/)
    expect(source).not.toContain('consumer.store')
    expect(source).not.toContain('consumer.uid')
  })

  it('负例直接访问缺少 inject 的属性，不误用 optional lookup', async () => {
    const source = await readFile(resolve(chapterRoot, 'src/service-lab.ts'), 'utf8')
    const negativeSource = source.slice(source.indexOf('export async function runMissingInjectScenario'))

    expect(negativeSource).toContain("ctx.courseGreeter.greet('learner')")
    expect(negativeSource).not.toContain('ctx.get(')
  })

  it('README 的本地链接都能解析', async () => {
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
