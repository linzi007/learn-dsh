import assert from 'node:assert/strict'
import {
  runAgentLoopScenario,
  runStepBudgetScenario,
} from './loop-lab.ts'

const positive = await runAgentLoopScenario()
const toolCalls = positive.events.filter(event => event.type === 'tool/call')
const toolResults = positive.events.filter(event => event.type === 'tool/result')
const turnEnd = positive.events.filter(event => event.type === 'turn/end').at(-1)

assert.equal(positive.requests.length, 2)
assert.equal(toolCalls.length, 1)
assert.equal(toolResults.length, 1)
assert.equal(turnEnd?.type, 'turn/end')
if (turnEnd?.type !== 'turn/end') throw new Error('missing turn/end')
assert.equal(turnEnd.data.reason.kind, 'completed')
assert.equal(positive.statusBeforeDispose, 'idle')
assert.match(positive.finalText, /计算结果：20 \+ 22 = 42/)
assert.equal(positive.agentMissingAfterDispose, true)
assert.equal(positive.sessionMissingAfterDispose, true)

console.log('PASS 1/2：真实 AgentLoop 完成两步 tool round-trip')
console.log(`  模型请求：${positive.requests.length} 次`)
console.log(`  简化轨迹：${positive.simplifiedTrace.join(' → ')}`)
console.log(`  最终文本：${positive.finalText}`)
console.log('  dispose：Agent 与 Session 均已从 Registry 移除')

const budget = await runStepBudgetScenario(2)
const budgetCalls = budget.events.filter(event => event.type === 'tool/call')
const budgetResults = budget.events.filter(event => event.type === 'tool/result')
const budgetSteps = budget.events.filter(event => event.type === 'step/start')

assert.equal(budget.requests.length, 2)
assert.equal(budgetCalls.length, 2)
assert.equal(budgetResults.length, 2)
assert.equal(budgetSteps.length, 2)
assert.equal(budget.turnEndReason.kind, 'blocked')
assert.equal(budget.statusBeforeDispose, 'idle')

console.log('')
console.log('PASS 2/2：负向探针在第 3 个拟议 step 前截断工具自循环')
console.log(`  maxStepsPerTurn：${budget.maxStepsPerTurn}`)
console.log(`  已执行模型请求 / 工具结果：${budget.requests.length} / ${budgetResults.length}`)
console.log(`  turn/end：${budget.turnEndReason.kind}`)
console.log('  最终状态：idle')
