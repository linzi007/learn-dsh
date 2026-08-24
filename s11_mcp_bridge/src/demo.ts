import assert from 'node:assert/strict'
import {
  MCP_SERVER_NAME,
  PUBLIC_FAILURE_TOOL_NAME,
  PUBLIC_LOOKUP_TOOL_NAME,
  runMcpBridgeScenario,
} from './mcp-bridge-lab.ts'
import {
  RAW_FAILURE_TOOL_NAME,
  RAW_LOOKUP_TOOL_NAME,
} from './fixture-contract.ts'

const result = await runMcpBridgeScenario()

assert.deepEqual([...result.discoveredNames].sort(), [
  PUBLIC_FAILURE_TOOL_NAME,
  PUBLIC_LOOKUP_TOOL_NAME,
].sort())
assert.equal(result.discoveredNames.includes(RAW_LOOKUP_TOOL_NAME), false)

assert.equal(result.rawNameCall.isError, true)
if (!result.rawNameCall.isError) throw new Error('raw tool name unexpectedly executed')
assert.equal(result.rawNameCall.error.info?.code, 'UNKNOWN_TOOL')

assert.equal(result.serverArgumentError.isError, true)
if (!result.serverArgumentError.isError) throw new Error('invalid MCP args unexpectedly succeeded')
assert.match(result.serverArgumentError.error.message, /MCP error -32602: Input validation error/)
assert.equal(result.serverArgumentError.error.info, undefined)

assert.equal(result.success.isError, false)
assert.equal(result.successValue.structuredContent?.rawToolName, RAW_LOOKUP_TOOL_NAME)
assert.equal(result.successValue.structuredContent?.callCount, 1)
assert.equal(result.successValue.structuredContent?.fixture, true)
assert.equal(result.childWasAlive, true)

assert.equal(result.mcpToolError.isError, true)
if (!result.mcpToolError.isError) throw new Error('MCP isError unexpectedly succeeded')
assert.match(result.mcpToolError.error.message, /\[local fixture\] rejected: expected boundary probe/)
assert.equal(result.mcpToolError.error.info, undefined)

assert.equal(result.childStoppedAfterDispose, true)
assert.deepEqual(result.namesAfterDispose, [])
assert.equal(result.publicNameAfterDispose.isError, true)
if (!result.publicNameAfterDispose.isError) throw new Error('disposed MCP tool unexpectedly executed')
assert.equal(result.publicNameAfterDispose.error.info?.code, 'UNKNOWN_TOOL')

console.log('PASS 1/4：真实 MCP stdio discovery 把 raw tools 注册成 server-qualified public names')
console.log(`  server namespace: ${MCP_SERVER_NAME}`)
console.log(`  discovered: ${result.discoveredNames.join(', ')}`)

console.log('')
console.log('PASS 2/4：public definition 命中闭包保存的 raw name，MCP server 在 handler 前拒绝错误参数')
console.log(`  raw direct call: ${result.rawNameCall.error.info?.code}`)
console.log(`  invalid args:    ${result.serverArgumentError.error.message.split('\n', 1)[0]}`)
console.log(`  server observed: ${result.successValue.structuredContent?.rawToolName}, callCount=${result.successValue.structuredContent?.callCount}`)

console.log('')
console.log('PASS 3/4：MCP isError 跨过协议桥后仍是模型可见的 ToolRuntime 失败')
console.log(`  raw failure tool: ${RAW_FAILURE_TOOL_NAME}`)
console.log(`  result: ${result.mcpToolError.error.message}`)

console.log('')
console.log('PASS 4/4：MCP Plugin Fiber dispose 同时注销工具并停止 local fixture 子进程')
console.log(`  child alive before dispose: ${result.childWasAlive}`)
console.log(`  child stopped:              ${result.childStoppedAfterDispose}`)
console.log(`  disposed call:              ${result.publicNameAfterDispose.error.info?.code}`)
