import assert from 'node:assert/strict'
import {
  PUBLISH_ALLOWED_CALL_ID,
  PUBLISH_REJECTED_CALL_ID,
  runNeverPolicyScenario,
  runNoAnswererScenario,
  runPermissionScenario,
} from './permission-lab.ts'

const main = await runPermissionScenario()
assert.deepEqual(
  main.workspaceWrites.map(write => write.target),
  ['draft', 'publish'],
)
assert.deepEqual(
  main.approvalAudit.map(pair => [pair.callId, pair.outcome]),
  [
    [String(PUBLISH_ALLOWED_CALL_ID), 'allowed-once'],
    [String(PUBLISH_REJECTED_CALL_ID), 'rejected'],
  ],
)
assert.equal(main.answererCalls, 2)
for (const pair of main.approvalAudit) {
  assert.deepEqual(pair.trace, [
    'tool/call',
    'approval/asked',
    'approval/decided',
    'tool/result',
  ])
}

console.log('PASS 1/3：draft / publish / system policy 经过真实 AgentLoop')
console.log(`  policy：${main.policy.map(item => `${item.target}:${item.decision}`).join(' → ')}`)
console.log(`  实际写入：${main.workspaceWrites.map(write => `${write.target}#${write.revision}`).join(', ')}`)
for (const pair of main.approvalAudit) {
  console.log(`  ${pair.callId}：${pair.trace.join(' → ')} = ${pair.outcome}`)
}
console.log('  allowed-once 后第二次 publish 仍重新 ask')

const noAnswerer = await runNoAnswererScenario()
assert.equal(noAnswerer.workspaceWrites.length, 0)
assert.equal(noAnswerer.approvalAudit[0]?.outcome, 'unavailable')
assert.match(noAnswerer.toolResults[0]?.text ?? '', /no approval channel is available/)

console.log('')
console.log('PASS 2/3：ask 没有 answerer 时 unavailable，立即 fail closed')
console.log(`  audit outcome：${noAnswerer.approvalAudit[0]?.outcome}`)
console.log(`  工具结果：${noAnswerer.toolResults[0]?.text}`)

const never = await runNeverPolicyScenario()
assert.equal(never.answererCalls, 0)
assert.equal(never.workspaceWrites.length, 0)
assert.equal(never.approvalAudit[0]?.outcome, 'rejected')

console.log('')
console.log('PASS 3/3：never policy 在 answerer 之前确定性拒绝')
console.log(`  answerer 调用次数：${never.answererCalls}`)
console.log(`  audit outcome：${never.approvalAudit[0]?.outcome}`)
console.log('  注意：Approval 控制 dispatch，不提供 filesystem / process sandbox')
