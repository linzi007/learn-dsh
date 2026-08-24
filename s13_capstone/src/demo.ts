import assert from 'node:assert/strict'
import {
  A_EDIT_CALL_ID,
  B_DIRECT_EDIT_CALL_ID,
  B_OUTSIDE_WRITE_CALL_ID,
  B_RETRY_EDIT_CALL_ID,
  B_SYMLINK_READ_CALL_ID,
  runCapstoneScenario,
} from './capstone-lab.ts'
import { FINAL_COURSE_CONTENT } from './capstone-fixtures.ts'

const result = await runCapstoneScenario()
const toolResult = (callId: string) => {
  const found = result.toolResults.find(candidate => candidate.callId === callId)
  if (found === undefined) throw new Error(`demo missing tool result for ${callId}`)
  return found
}

assert.equal(result.contextAFlushObserved, true)
assert.equal(result.contextBFlushObserved, true)
assert.equal(result.contextACwd, result.workspace)
assert.equal(result.contextBCwd, result.workspace)
assert.deepEqual(result.durableEventsAfterContextA, result.contextAEvents)
assert.deepEqual(result.durableEventsAfterContextB, result.finalEvents)
assert.deepEqual(result.turnNumbers, [1, 2])
assert.equal(result.firstLiveSeq, result.contextAEvents.length)

console.log('S13 PASS 1/3：Context A flush 后，Context B 从同一 JSONL Session 继续 Turn 2')
console.log(`  artifact：${result.artifactFilename}`)
console.log(`  Session cwd：${result.contextBCwd}`)
console.log(`  turn：${result.turnNumbers.join(' → ')}`)

assert.equal(toolResult(String(B_DIRECT_EDIT_CALL_ID)).errorCode, 'FS_NOT_OBSERVED')
assert.equal(toolResult(String(B_RETRY_EDIT_CALL_ID)).isError, false)
assert.equal(result.finalCourseContent, FINAL_COURSE_CONTENT)
assert.deepEqual(
  result.approvalAnswers.map(answer => [answer.callId, answer.outcome]),
  [
    [String(A_EDIT_CALL_ID), 'allowed-once'],
    [String(B_DIRECT_EDIT_CALL_ID), 'allowed-once'],
    [String(B_RETRY_EDIT_CALL_ID), 'allowed-once'],
  ],
)

console.log('S13 PASS 2/3：恢复 transcript 不恢复 observation cache，read 后重试成功')
console.log(`  首次 edit：${toolResult(String(B_DIRECT_EDIT_CALL_ID)).errorCode}`)
console.log(`  第二次 edit：${toolResult(String(B_RETRY_EDIT_CALL_ID)).text}`)
console.log('  三次获准 mutation 都分别留下 allowed-once 审批')

assert.equal(result.dispatchedCallIds.includes(String(B_OUTSIDE_WRITE_CALL_ID)), false)
assert.equal(result.dispatchedCallIds.includes(String(B_SYMLINK_READ_CALL_ID)), false)
assert.equal(result.outsideFixtureUnchanged, true)
assert.equal(result.outsideFixtureLeakedToTranscript, false)
assert.equal(result.tempRootRemoved, true)

console.log('S13 PASS 3/3：父目录与 symlink 逃逸均在 tool body 前拒绝')
console.log(`  ../outside.txt：${toolResult(String(B_OUTSIDE_WRITE_CALL_ID)).text}`)
console.log(`  ${String(B_SYMLINK_READ_CALL_ID)}：${toolResult(String(B_SYMLINK_READ_CALL_ID)).text}`)
console.log('  outside fixture 未修改、内容未进入 transcript、临时根已精确清理')
console.log('  边界：这是应用层路径 / dispatch policy，不是 OS sandbox。')
