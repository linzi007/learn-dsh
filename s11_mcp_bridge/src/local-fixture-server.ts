/**
 * 本章自写的确定性 local fixture。
 *
 * 这是使用官方 SDK 跑在独立子进程中的真实 MCP stdio server；initialize、
 * tools/list 与 tools/call 都走 MCP JSON-RPC。只有查询答案、计数器和失败条件
 * 是课程 fixture，不代表生产 MCP 服务，也没有引用上游测试 fixture。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  RAW_FAILURE_TOOL_NAME,
  RAW_LOOKUP_TOOL_NAME,
} from './fixture-contract.ts'

const explanations = {
  plugin: 'Plugin 把一组能力挂到 Context，并由自己的 Fiber 持有生命周期。',
  effect: 'Effect 登记资源的清理函数，让资源随所属 Fiber 一起释放。',
  fiber: 'Fiber 是一次 Plugin 运行的生命周期边界；dispose 会触发其 Effect 清理。',
} as const

const conceptSchema = z.enum(['plugin', 'effect', 'fiber'])
let lookupCalls = 0

const server = new McpServer(
  { name: 'learn-dsh-local-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.registerTool(RAW_LOOKUP_TOOL_NAME, {
  title: 'Course concept lookup',
  description: '从确定性课程 fixture 查询一个 lifecycle 概念。',
  inputSchema: {
    concept: conceptSchema.describe('要查询的 lifecycle 概念。'),
  },
  outputSchema: {
    rawToolName: z.literal(RAW_LOOKUP_TOOL_NAME),
    concept: conceptSchema,
    explanation: z.string(),
    fixture: z.literal(true),
    callCount: z.number().int().positive(),
    serverPid: z.number().int().positive(),
  },
}, async ({ concept }) => {
  lookupCalls += 1
  const structuredContent = {
    rawToolName: RAW_LOOKUP_TOOL_NAME,
    concept,
    explanation: explanations[concept],
    fixture: true as const,
    callCount: lookupCalls,
    serverPid: process.pid,
  }
  return {
    content: [{
      type: 'text',
      text: `[local fixture] ${concept}: ${structuredContent.explanation}`,
    }],
    structuredContent,
  }
})

server.registerTool(RAW_FAILURE_TOOL_NAME, {
  title: 'Course tool-result failure',
  description: '确定性返回 MCP isError，用于观察 tool-result 失败边界。',
  inputSchema: {
    reason: z.string().min(1).describe('希望 fixture 回显的失败原因。'),
  },
}, async ({ reason }) => ({
  content: [{
    type: 'text',
    text: `[local fixture] rejected: ${reason}`,
  }],
  isError: true,
}))

await server.connect(new StdioServerTransport())
