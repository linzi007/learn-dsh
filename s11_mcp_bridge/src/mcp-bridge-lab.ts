import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { Config, McpResult } from '@deepseek-ai/dsh-mcp-client'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { fileURLToPath } from 'node:url'
import {
  RAW_FAILURE_TOOL_NAME,
  RAW_LOOKUP_TOOL_NAME,
} from './fixture-contract.ts'

export const MCP_SERVER_NAME = 'course_fixture'
export const PUBLIC_LOOKUP_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${RAW_LOOKUP_TOOL_NAME}`
export const PUBLIC_FAILURE_TOOL_NAME = `mcp__${MCP_SERVER_NAME}__${RAW_FAILURE_TOOL_NAME}`

const fixtureServerPath = fileURLToPath(new URL('./local-fixture-server.ts', import.meta.url))
const chapterRoot = fileURLToPath(new URL('../', import.meta.url))

const bridgeConfig: Config = {
  transport: 'stdio',
  serverName: MCP_SERVER_NAME,
  command: process.execPath,
  args: [fixtureServerPath],
  env: {},
  cwd: chapterRoot,
  toolCallTimeoutMs: 10_000,
  failOnStartupError: true,
  reconnect: { enabled: false },
}

export interface LookupStructuredContent {
  readonly [key: string]: string | number | boolean
  readonly rawToolName: typeof RAW_LOOKUP_TOOL_NAME
  readonly concept: 'plugin' | 'effect' | 'fiber'
  readonly explanation: string
  readonly fixture: true
  readonly callCount: number
  readonly serverPid: number
}

export interface McpBridgeScenarioResult {
  readonly discoveredNames: readonly string[]
  readonly lookupSchemaDescription: string
  readonly lookupSchemaParameters: unknown
  readonly rawNameCall: ToolExecutionResult
  readonly serverArgumentError: ToolExecutionResult
  readonly success: ToolExecutionResult
  readonly successValue: McpResult<LookupStructuredContent>
  readonly mcpToolError: ToolExecutionResult
  readonly childWasAlive: boolean
  readonly childStoppedAfterDispose: boolean
  readonly namesAfterDispose: readonly string[]
  readonly publicNameAfterDispose: ToolExecutionResult
}

function execute(
  root: Context,
  callId: string,
  name: string,
  args: unknown,
): Promise<ToolExecutionResult> {
  return root.tools.execute({
    callId: CallId(callId),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 7_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return !isProcessAlive(pid)
}

function requireSuccessValue(result: ToolExecutionResult): McpResult<LookupStructuredContent> {
  if (result.isError) throw new Error(`lookup unexpectedly failed: ${result.error.message}`)
  return result.value as unknown as McpResult<LookupStructuredContent>
}

/**
 * 真实组合路径：ToolRuntime -> dsh-mcp-client -> MCP stdio -> local fixture。
 * LLM 不在本章增量内，因此所有调用都从 ToolRuntime 的公开 execute API 发起。
 */
export async function runMcpBridgeScenario(): Promise<McpBridgeScenarioResult> {
  const root = new Context()

  try {
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRuntime, { mode: 'native' })

    const bridgeFiber = root.plugin(McpClient, bridgeConfig)
    await bridgeFiber.await()

    const schemas = root.tools.schemas()
    const discoveredNames = schemas.map(schema => schema.name)
    const lookupSchema = schemas.find(schema => schema.name === PUBLIC_LOOKUP_TOOL_NAME)
    if (lookupSchema === undefined) throw new Error('MCP lookup schema was not discovered')

    // raw name 从未注册进 ToolRuntime；它只存在于 MCP wire 边界。
    const rawNameCall = await execute(
      root,
      's11-raw-name',
      RAW_LOOKUP_TOOL_NAME,
      { concept: 'plugin' },
    )

    // MCP bridge 公开 server schema，但不像 defineTool() 那样在本地包一层
    // validateArgs；无效 enum 会越过 bridge，在 MCP server SDK 的 handler
    // 之前以 JSON-RPC -32602 被拒绝。随后首次有效 handler 调用仍应是 #1。
    const serverArgumentError = await execute(
      root,
      's11-invalid-args',
      PUBLIC_LOOKUP_TOOL_NAME,
      { concept: 'unknown' },
    )
    const success = await execute(
      root,
      's11-success',
      PUBLIC_LOOKUP_TOOL_NAME,
      { concept: 'plugin' },
    )
    const successValue = requireSuccessValue(success)
    const serverPid = successValue.structuredContent?.serverPid
    if (serverPid === undefined) throw new Error('fixture omitted serverPid')
    const childWasAlive = isProcessAlive(serverPid)

    const mcpToolError = await execute(
      root,
      's11-mcp-error',
      PUBLIC_FAILURE_TOOL_NAME,
      { reason: 'expected boundary probe' },
    )

    await bridgeFiber.dispose()
    const namesAfterDispose = root.tools.schemas().map(schema => schema.name)
    const childStoppedAfterDispose = await waitForProcessExit(serverPid)
    const publicNameAfterDispose = await execute(
      root,
      's11-after-dispose',
      PUBLIC_LOOKUP_TOOL_NAME,
      { concept: 'plugin' },
    )

    return {
      discoveredNames,
      lookupSchemaDescription: lookupSchema.description,
      lookupSchemaParameters: lookupSchema.parameters,
      rawNameCall,
      serverArgumentError,
      success,
      successValue,
      mcpToolError,
      childWasAlive,
      childStoppedAfterDispose,
      namesAfterDispose,
      publicNameAfterDispose,
    }
  } finally {
    await root.fiber.dispose()
  }
}
