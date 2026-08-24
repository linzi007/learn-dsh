import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

const requiredFiles = [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'UPSTREAM.md',
  'THIRD_PARTY_NOTICES.md',
  's01_lifecycle_microscope/README.md',
  's01_lifecycle_microscope/src/demo.ts',
  's01_lifecycle_microscope/tests/lifecycle.test.ts',
]

const markdownFiles = [
  'README.md',
  'CONTRIBUTING.md',
  'UPSTREAM.md',
  'THIRD_PARTY_NOTICES.md',
  's01_lifecycle_microscope/README.md',
  'validation/README.md',
]

describe('课程仓库结构', () => {
  it('保留 v0.1 必需的开源与教学文件', async () => {
    await Promise.all(requiredFiles.map(file => access(resolve(repositoryRoot, file))))
  })

  it('Markdown 中的本地链接都能解析', async () => {
    const missingLinks: string[] = []

    for (const file of markdownFiles) {
      const absoluteFile = resolve(repositoryRoot, file)
      const markdown = await readFile(absoluteFile, 'utf8')
      const links = markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)

      for (const match of links) {
        const target = match[1]?.trim()
        if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue

        const pathWithoutAnchor = decodeURIComponent(target.split('#', 1)[0] ?? '')
        if (!pathWithoutAnchor) continue

        try {
          await access(resolve(dirname(absoluteFile), pathWithoutAnchor))
        } catch {
          missingLinks.push(`${file} → ${target}`)
        }
      }
    }

    expect(missingLinks).toEqual([])
  })

  it('上游源码链接固定到课程基线，而不是浮动分支', async () => {
    const upstream = await readFile(resolve(repositoryRoot, 'UPSTREAM.md'), 'utf8')

    expect(upstream).toContain('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
    expect(upstream).not.toMatch(/github\.com\/deepseek-ai\/deepseek-harness\/blob\/(?:master|main)\//)
  })
})
