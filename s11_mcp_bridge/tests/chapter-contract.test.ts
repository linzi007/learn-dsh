import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

describe('第 11 章文档与实现契约', () => {
  it('保留手把手教学结构，且不规定统一时长', async () => {
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
    expect(readme).toContain('[10 Compaction](../s10_compaction/)')
    expect(readme).toContain('[12 Subagent 与 Workflow](../s12_subagent_workflow/)')
  })

  it('先解释 MCP、名称、参数、错误和生命周期边界', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const required of [
      'MCP Host',
      'MCP Client',
      'MCP Server',
      '`initialize`',
      '`tools/list`',
      '`tools/call`',
      'raw name',
      'public name',
      '`mcp__<serverName>__<rawName>`',
      '`serverName`',
      '`inputSchema`',
      '`MCP error -32602`',
      '`INVALID_ARGS`',
      'canonical `McpResult`',
      '`structuredContent`',
      '`isError`',
      '`UNKNOWN_TOOL`',
      '`bridgeFiber.dispose()`',
    ]) {
      expect(readme, `缺少核心边界：${required}`).toContain(required)
    }
    expect(readme).toContain('safe-name clean case')
    expect(readme).toContain('normalize')
    expect(readme).toContain('闭包保存 raw name')
    expect(readme).not.toContain('wire 侧还原为 raw name')
  })

  it('明确 local fixture 是真实协议 server，但不冒充生产实现', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')
    const server = await readFile(resolve(chapterRoot, 'src/local-fixture-server.ts'), 'utf8')

    expect(readme).toContain('**Fixture 声明：**')
    expect(readme).toContain('真实 MCP protocol server 不等于真实生产业务 server')
    expect(readme).toContain('没有引用上游测试 fixture')
    expect(server).toContain("from '@modelcontextprotocol/sdk/server/mcp.js'")
    expect(server).toContain("from '@modelcontextprotocol/sdk/server/stdio.js'")
    expect(server).toContain('new McpServer(')
    expect(server).toContain('new StdioServerTransport()')
    expect(server).toContain('local fixture')
    expect(server).not.toContain('deepseek-harness/packages/mcp/mcp-client/tests')
  })

  it('只使用已发布 MCP Client 公开入口，并经真实 ToolRuntime 调用', async () => {
    const lab = await readFile(resolve(chapterRoot, 'src/mcp-bridge-lab.ts'), 'utf8')
    const source = `${lab}\n${await readFile(resolve(chapterRoot, 'src/local-fixture-server.ts'), 'utf8')}`

    expect(lab).toContain("import * as McpClient from '@deepseek-ai/dsh-mcp-client'")
    expect(lab).toContain("import type { Config, McpResult } from '@deepseek-ai/dsh-mcp-client'")
    expect(lab).toContain("from '@deepseek-ai/dsh-tools'")
    expect(lab).toContain("root.plugin(ToolRuntime, { mode: 'native' })")
    expect(lab).toContain('root.plugin(McpClient, bridgeConfig)')
    expect(lab).toContain('await bridgeFiber.await()')
    expect(lab).toContain('root.tools.execute({')
    expect(lab).toContain('await bridgeFiber.dispose()')
    expect(lab).not.toContain('@deepseek-ai/dsh-mcp-client/src/')
    expect(source).not.toMatch(/class\s+(?:Mock|Fake)(?:Mcp|ToolRuntime|Client)/)
    expect(source).not.toContain('ScriptedLlmAdapter')
  })

  it('自动证明 raw/public、server 参数错误、MCP isError 与 child cleanup', async () => {
    const lab = await readFile(resolve(chapterRoot, 'src/mcp-bridge-lab.ts'), 'utf8')
    const tests = await readFile(resolve(chapterRoot, 'tests/mcp-bridge.test.ts'), 'utf8')
    const source = `${lab}\n${tests}`

    expect(source).toContain('mcp__${MCP_SERVER_NAME}__${RAW_LOOKUP_TOOL_NAME}')
    expect(source).toContain("'s11-raw-name'")
    expect(source).toContain("'s11-invalid-args'")
    expect(source).toContain('MCP error -32602: Input validation error')
    expect(source).toContain('structuredContent?.callCount')
    expect(source).toContain("'s11-mcp-error'")
    expect(source).toContain('mcpToolError')
    expect(source).not.toContain('protocolError')
    expect(source).toContain('childStoppedAfterDispose')
    expect(source).toContain("'s11-after-dispose'")
    expect(source).toContain('UNKNOWN_TOOL')
  })

  it('固定公开包版本与上游 commit，链接不使用浮动分支或行号', async () => {
    const readme = await readFile(resolve(chapterRoot, 'README.md'), 'utf8')

    for (const dependency of [
      '@deepseek-ai/cordis@4.0.1',
      '@deepseek-ai/dsh-mcp-client@0.1.1-rc.2',
      '@deepseek-ai/dsh-system-prompt@0.1.1-rc.2',
      '@deepseek-ai/dsh-tools@0.1.1-rc.2',
      '@deepseek-ai/dsh-llm@0.1.1-rc.2',
      '@modelcontextprotocol/sdk@1.29.0',
      'zod@4.4.3',
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
