import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 8 章文档与实现契约', () => {
  it('保留手把手教学结构，且不规定统一时长', async () => {
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
      '## 教学简化与生产边界',
      '## 上游观察卡',
    ]) {
      expect(readme, `缺少章节结构：${heading}`).toContain(heading)
    }

    expect(readme).not.toContain('预计时间')
    expect(readme).toContain('[07 Permission](../s07_permission/)')
    expect(readme).toContain('[09 Background jobs](../s09_background_jobs/)')
  })

  it('先解释 persistence 与恢复词汇，再进入磁盘实验', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '`SessionPersistence`',
      '`JsonlSessionPersistence`',
      '`PersistenceCoordinator`',
      '`flush()`',
      '`prepare()`',
      '`agents.resume()`',
      'durable prefix',
      '`firstLiveSeq`',
      '`session/end-seed`',
      '`deriveMessages()`',
      'Projection replay',
      'torn tail',
      'committed corruption',
      '`step/end`',
      '`interrupted`',
    ]) {
      expect(readme, `缺少核心概念：${required}`).toContain(required)
    }
  })

  it('公开写出完整加载顺序，没有复用隐藏 AgentLoop 顺序的 S06 helper', async () => {
    const harness = await readFile(resolve(chapterRoot, 'src/persistence-harness.ts'), 'utf8')

    const orderedFragments = [
      'mountAgentLoopTestDependencies(ctx)',
      'ctx.llm.registerAdapter([SCRIPTED_PROVIDER], adapter)',
      'ctx.plugin(SessionProjectionRegistry)',
      'ctx.sessionProjections.register(todoProjection)',
      'ctx.plugin(AgentLoop, { agents: [] })',
      'ctx.plugin(JsonlSessionPersistence',
    ]

    let previous = -1
    for (const fragment of orderedFragments) {
      const index = harness.indexOf(fragment)
      expect(index, `缺少组合步骤：${fragment}`).toBeGreaterThan(previous)
      previous = index
    }

    expect(harness).toContain("compression: 'none'")
    expect(harness).toContain('packChunks: false')
    expect(harness).toContain('../../s04_projection_replay/src/todo-domain.ts')
    expect(harness).toContain('../../s06_keyless_agent_loop/src/scripted-llm.ts')
    expect(harness).not.toContain('mountKeylessAgentLoop')
  })

  it('正向场景明确执行 flush、dispose、resume，再验证 Projection 与 seed marker', async () => {
    const lab = await readFile(resolve(chapterRoot, 'src/persistence-lab.ts'), 'utf8')

    for (const required of [
      "ctxA.on('agent/turn-stopping'",
      "agent.session.append('todo/write'",
      'ctxA.sessions.flush(handleA.agent.session)',
      'handleA.dispose()',
      'resumePersistenceAgent(ctxB, ROUND_TRIP_SESSION_ID)',
      'handleB.agent.session.firstLiveSeq',
      "seedMarker?.type !== 'session/end-seed'",
      'handleB.agent.session.deriveMessages()',
      'projectionTodos(ctxB, handleB.agent.session)',
      'ctxB.sessions.flush(handleB.agent.session)',
    ]) {
      expect(lab, `缺少正向恢复证据：${required}`).toContain(required)
    }
  })

  it('负例区分 torn tail 与 committed corruption，且不绑定具体 corruption class', async () => {
    const recovery = await readFile(resolve(chapterRoot, 'src/recovery-lab.ts'), 'utf8')
    const tests = await readFile(resolve(chapterRoot, 'tests/persistence.test.ts'), 'utf8')
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')
    const executableSource = `${recovery}\n${tests}`

    expect(recovery).toContain('appendFile(fixture.path, TORN_FRAGMENT')
    expect(recovery).toContain('syntheticClosers')
    expect(recovery).toContain('bytesBeforeResume.equals(bytesAfterResume)')
    expect(tests).toContain("toContain('unparsable committed event')")
    expect(executableSource).not.toContain('SessionPersistenceCorruptionError')

    expect(readme).toContain('SessionPersistenceCorruptionError')
    expect(readme).toContain('上游贡献候选')
    expect(readme).toContain('backend.loadStored(id)')
    expect(readme).toContain('绝不写 `instanceof SessionPersistenceCorruptionError`')
  })

  it('临时根由 mkdtemp 产生，并在精确路径 guard 后递归清理', async () => {
    const fixtures = await readFile(resolve(chapterRoot, 'src/jsonl-fixtures.ts'), 'utf8')

    expect(fixtures).toContain('mkdtemp(')
    expect(fixtures).toContain('dirname(target) !== expectedParent')
    expect(fixtures).toContain('basename(target).startsWith(TEMP_BASENAME_PREFIX)')
    expect(fixtures).toContain('rm(target, { recursive: true, force: true })')
    expect(fixtures).not.toMatch(/rm\(\s*(?:tmpdir\(\)|process\.env|['"]~['"])/)
  })

  it('明确 Windows/Koffi 未验证边界，不从本章外推跨平台结论', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      '`koffi:false`',
      '没有验证 Windows JSONL durability',
      'Koffi native build',
      'macOS/Linux',
      '不能据此宣称跨平台持久化已经通过',
    ]) {
      expect(readme).toContain(required)
    }
  })

  it('固定公开包版本与上游 commit，链接不使用浮动分支或行号', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const dependency of [
      '@deepseek-ai/dsh-session-persistence-jsonl@0.1.1-rc.2',
      '@deepseek-ai/dsh-session-persistence@0.1.1-rc.2',
      '@deepseek-ai/dsh-session@0.1.1-rc.2',
      '@deepseek-ai/dsh-session-projection@0.1.1-rc.2',
      '@deepseek-ai/dsh-agent-loop@0.1.1-rc.2',
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
