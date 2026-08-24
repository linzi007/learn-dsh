import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

async function chapterFile(path: string): Promise<string> {
  return readFile(resolve(chapterRoot, path), 'utf8')
}

describe('第 13 章文档与实现契约', () => {
  it('保留手把手综合章节结构、上一章与课程收尾链接，且不规定统一时长', async () => {
    const readme = await chapterFile('README.md')

    for (const heading of [
      '## 问题',
      '## 先认识十二个基本概念',
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

    expect(readme).toContain('[12 Subagent 与 Worker Workflow](../s12_subagent_workflow/)')
    expect(readme).toContain('[返回 Learn DSH 课程首页](../README.md)')
    expect(readme).not.toContain('预计时间')
    expect(readme).not.toMatch(/\d+\s*(?:分钟|小时)完成/)
  })

  it('先解释 coding harness、FS 四层、cwd、observation、Approval 与 JSONL', async () => {
    const readme = await chapterFile('README.md')

    for (const concept of [
      'Mini coding harness',
      '`ScriptedLlmAdapter`',
      '文件系统四层栈',
      '`Session.header.cwd`',
      '`FsTarget`',
      '`resolve()`',
      '`contains()`',
      '`tools/pre-execute`',
      '`ApprovalService`',
      '`allowed-once`',
      '`fs-observation-policy`',
      '`FS_NOT_OBSERVED`',
      'Transcript persistence 不等于 policy cache persistence',
      '`JsonlSessionPersistence`',
      '`mkdtemp`',
    ]) {
      expect(readme, `缺少核心概念：${concept}`).toContain(concept)
    }
  })

  it('明确 Approval 先成功但 tool 可失败，retry 必须重新审批', async () => {
    const readme = await chapterFile('README.md')
    const lab = await chapterFile('src/capstone-lab.ts')

    expect(readme).toContain('第二次批准后工具仍然失败')
    expect(readme).toContain('Approval 只决定是否 dispatch')
    expect(readme).toContain('两次都单独 ask')
    expect(readme).toContain('重试仍需新 Approval')
    expect(lab).toContain("installAllowedOnceAnswerer(handle, 'B', approvals)")
    expect(lab).toContain('B_DIRECT_EDIT_CALL_ID')
    expect(lab).toContain('B_RETRY_EDIT_CALL_ID')
  })

  it('明确 ../outside denial 在 ask 与 dispatch 前，symlink 使用规范身份判断', async () => {
    const readme = await chapterFile('README.md')
    const policy = await chapterFile('src/workspace-policy.ts')
    const lab = await chapterFile('src/capstone-lab.ts')

    expect(readme).toContain('没有 `approval/asked`，也没有 `tools/execute`')
    expect(readme).toContain('realpath')
    expect(readme).toContain('symlink')
    expect(policy).toContain('ctx.fs.resolve')
    expect(policy).toContain('ctx.fs.contains')
    expect(policy.indexOf('if (!insideWorkspace)')).toBeLessThan(policy.indexOf("if (MUTATION_TOOLS.has(exec.name))"))
    expect(lab).toContain("file_path: '../outside.txt'")
    expect(lab).toContain("file_path: ESCAPE_LINK_NAME")
  })

  it('明确 containment 只是应用层 dispatch policy，并记录 path TOCTOU 边界', async () => {
    const readme = await chapterFile('README.md')
    const policy = await chapterFile('src/workspace-policy.ts')

    expect(readme).toContain('不是 OS sandbox')
    expect(readme).toContain('TOCTOU')
    expect(readme).toContain('symlink')
    expect(readme).toContain('进程 / 容器 sandbox')
    expect(readme).toContain('其它代码、子进程、网络或直接 `ctx.fs` 调用')
    expect(policy).toContain('不是 OS sandbox')
  })

  it('唯一 fake 明确复用 S06，最终回答现场读取真实 tool-result', async () => {
    const readme = await chapterFile('README.md')
    const lab = await chapterFile('src/capstone-lab.ts')

    expect(readme).toContain('唯一 fake')
    expect(readme).toContain('从本次 `GenerateOptions.messages` 里找到真实 `tool-result`')
    expect(lab).toContain("from '../../s06_keyless_agent_loop/src/scripted-llm.ts'")
    expect(lab).toContain('requireToolResult(request, A_EDIT_CALL_ID)')
    expect(lab).toContain('requireToolResult(request, B_DIRECT_EDIT_CALL_ID)')
    expect(lab).toContain('renderedTextOf')
    expect(lab).not.toMatch(/class\s+\w*(?:AgentLoop|LocalFileSystem|ApprovalService|JsonlSessionPersistence)/)
  })

  it('组合真实公开包、Session meta.cwd 与 agent-scoped approval answerer', async () => {
    const harness = await chapterFile('src/capstone-harness.ts')
    const lab = await chapterFile('src/capstone-lab.ts')
    const combined = `${harness}\n${lab}`

    for (const packageName of [
      '@deepseek-ai/dsh-agent-loop',
      '@deepseek-ai/dsh-fs-local',
      '@deepseek-ai/dsh-fs-observation-policy',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-user-approval',
      '@deepseek-ai/dsh-session-persistence-jsonl',
    ]) {
      expect(combined).toContain(`from '${packageName}'`)
    }
    expect(harness).toContain('meta: { cwd: workspace }')
    expect(harness).toContain('ctx.agents.resume')
    expect(lab).toContain("handle.agent.ctx.on('approval/request'")
    expect(combined).not.toMatch(/from '@deepseek-ai\/[^']+\/src\//)
  })

  it('固定四个 FS 直接依赖版本和上游 commit，源码链接不用浮动分支或行号', async () => {
    const readme = await chapterFile('README.md')

    for (const dependency of [
      '@deepseek-ai/dsh-fs@0.1.1-rc.2',
      '@deepseek-ai/dsh-fs-local@0.1.1-rc.2',
      '@deepseek-ai/dsh-fs-observation-policy@0.1.1-rc.2',
      '@deepseek-ai/dsh-tool-fs@0.1.1-rc.2',
    ]) {
      expect(readme).toContain(dependency)
    }
    expect(readme).toContain('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
    expect(readme).not.toMatch(/github\.com\/deepseek-ai\/deepseek-harness\/(?:blob|tree)\/(?:main|master)\//)
    expect(readme).not.toMatch(/github\.com\/deepseek-ai\/deepseek-harness\/(?:blob|tree)\/[^)]+#L\d+/)
  })

  it('fixture 只清理精确 mkdtemp 根，README 的本地文件链接都能解析', async () => {
    const fixture = await chapterFile('src/capstone-fixtures.ts')
    const readmePath = resolve(chapterRoot, 'README.md')
    const readme = await readFile(readmePath, 'utf8')
    const missingLinks: string[] = []

    expect(fixture).toContain('mkdtemp')
    expect(fixture).toContain("dirname(target) !== resolve(tmpdir())")
    expect(fixture).toContain("basename(target).startsWith(TEMP_BASENAME_PREFIX)")
    expect(fixture).not.toContain('process.env')

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
