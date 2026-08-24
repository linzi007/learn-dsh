import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 5 章文档与实现契约', () => {
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
      '## 预期观察',
      '## 对照真实源码',
      '## 验收',
      '## 教学简化与生产边界',
      '## 上游观察卡',
    ]) {
      expect(readme, `缺少章节结构：${heading}`).toContain(heading)
    }

    expect(readme).not.toContain('预计时间')
    expect(readme).toContain('[04 Projection replay](../s04_projection_replay/)')
  })

  it('先解释 Tool contract 的基本 API，再让学习者运行 pipeline', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '`ToolDefinition`',
      '`ToolSchema`',
      '`defineTool`',
      '`parameters`',
      '`execute`',
      '`output.schema`',
      'canonical value',
      '`output.render`',
      '`content`',
      '`ctx.tools.register()`',
      '`ctx.tools.schemas()`',
      '`ctx.tools.execute()`',
      '`ToolExecutionResult`',
      '`CallId`',
      '`AbortSignal`',
      '`tools/result`',
      '`tool/result`',
      '`INVALID_ARGS`',
      '`INVALID_TOOL_OUTPUT`',
      '`UNKNOWN_TOOL`',
    ]) {
      expect(readme, `缺少核心契约：${required}`).toContain(required)
    }
  })

  it('直接组合已发布公开包，且 course_add 只有一个正式定义', async () => {
    const tool = await readFile(resolve(chapterRoot, 'src/course-add-tool.ts'), 'utf8')
    const lab = await readFile(resolve(chapterRoot, 'src/tool-contract-lab.ts'), 'utf8')
    const source = `${tool}\n${lab}`

    expect(tool).toContain("from '@deepseek-ai/dsh-tools'")
    expect(lab).toContain("from '@deepseek-ai/dsh-system-prompt'")
    expect(lab).toContain("from '@deepseek-ai/dsh-llm'")
    expect(lab).toContain("root.plugin(ToolRuntime, { mode: 'native' })")
    expect(lab).toContain('root.tools.execute({')
    expect(tool.match(/defineTool\s*\(/g)).toHaveLength(1)
    expect(source).not.toMatch(/class\s+\w*ToolRegistry/)
    expect(source).not.toMatch(/function\s+\w*(?:validateSchema|dispatchTool)/)
    expect(source).not.toContain('/src/')
  })

  it('为 S06 保留稳定的跨章复用出口，而不是复制工具 schema', async () => {
    const tool = await readFile(resolve(chapterRoot, 'src/course-add-tool.ts'), 'utf8')

    expect(tool).toContain('export const COURSE_ADD_TOOL_NAME')
    expect(tool).toContain('export const courseAddTool = defineTool')
    expect(tool).toContain('export const courseAddToolPlugin')
    expect(tool).toContain("inject: ['tools']")
    expect(tool).toContain('ctx.tools.register(courseAddTool)')
  })

  it('明确固定公开包版本与上游 commit，链接不使用浮动分支或行号', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const dependency of [
      '@deepseek-ai/dsh-tools@0.1.1-rc.2',
      '@deepseek-ai/dsh-system-prompt@0.1.1-rc.2',
      '@deepseek-ai/dsh-llm@0.1.1-rc.2',
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
