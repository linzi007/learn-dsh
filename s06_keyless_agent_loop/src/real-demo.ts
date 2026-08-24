import assert from 'node:assert/strict'
import {
  REAL_DEEPSEEK_MAX_STEPS,
  REAL_DEEPSEEK_MAX_TOKENS,
} from './real-agent-harness.ts'
import { resolveRealDeepSeekConfig } from './real-config.ts'
import { runRealDeepSeekScenario } from './real-deepseek-lab.ts'

const config = resolveRealDeepSeekConfig()

console.log('准备真实 DeepSeek 实验（会访问网络并产生少量模型费用）')
console.log(`  provider / model：${config.provider} / ${config.model}`)
console.log(`  边界：thinking=off，maxTokens=${REAL_DEEPSEEK_MAX_TOKENS}，maxStepsPerTurn=${REAL_DEEPSEEK_MAX_STEPS}`)

const result = await runRealDeepSeekScenario(config)

if (result.turnEndReason.kind === 'error') {
  throw new Error(
    `真实 DeepSeek 请求失败 [${result.turnEndReason.error.code}]。请按 S06 README 的稳定错误码表排查；CLI 不回显不受信端点的原始错误正文。`,
  )
}

assert.equal(result.timedOut, false, '真实实验超过 120 秒并已取消')
assert.equal(result.turnEndReason.kind, 'completed')
assert.equal(result.statusBeforeDispose, 'idle')
assert.ok(result.requestContexts.length >= 1)
assert.ok(result.requestContexts.every(context => (
  context.provider === config.provider && context.model === config.model
)))
assert.ok(result.courseAddCallId, '模型没有实际调用 course_add')
assert.deepEqual(JSON.parse(result.courseAddArguments ?? ''), { left: 20, right: 22 })
assert.equal(result.courseAddResultIsError, false)
assert.match(result.courseAddResultText, /20 \+ 22 = 42/)
assert.match(result.finalText, /42/)
assert.ok(result.usage.calls >= 2)
assert.ok(result.usage.calls <= REAL_DEEPSEEK_MAX_STEPS)
assert.equal(result.usage.calls, result.assistantMessageCount)
assert.ok(result.usage.inputTokens + (result.usage.cacheReadTokens ?? 0) > 0)
assert.ok(result.usage.outputTokens > 0)
assert.equal(result.agentMissingAfterDispose, true)
assert.equal(result.sessionMissingAfterDispose, true)

console.log('')
console.log('PASS 1/2：真实模型确实选择并执行了 course_add')
console.log(`  CallId：${result.courseAddCallId}`)
console.log(`  工具结果：${result.courseAddResultText}`)
console.log(`  最终回答：${result.finalText}`)

console.log('')
console.log('PASS 2/2：真实调用留下 route、usage 与 teardown 证据')
console.log(`  模型请求 / input / cache-read / output tokens：${result.usage.calls} / ${result.usage.inputTokens} / ${result.usage.cacheReadTokens ?? 0} / ${result.usage.outputTokens}`)
console.log('  turn/end → idle；dispose 后 Agent 与 Session 均已移除')
console.log('  配置解析结果只含 provider/model；输出未打印 API Key')
