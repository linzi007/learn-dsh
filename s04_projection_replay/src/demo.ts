import assert from 'node:assert/strict'
import {
  runMutationSilenceScenario,
  runProjectionReplayScenario,
} from './projection-lab.ts'

const replay = await runProjectionReplayScenario()
assert.deepEqual(replay.incrementalValue, replay.manualFullFoldValue)
assert.deepEqual(replay.manualFullFoldValue, replay.seedReplayValue)
assert.deepEqual(replay.changes.map(change => change.seq), [1, 2])
assert.equal(replay.replayEventTypes.at(-1), 'session/end-seed')

console.log('PASS 1/2：同一个 transition 的三条路径得到同一 todo 列表')
console.log(`  live incremental: ${JSON.stringify(replay.incrementalValue)}`)
console.log(`  manual full fold: ${JSON.stringify(replay.manualFullFoldValue)}`)
console.log(`  seed replay:      ${JSON.stringify(replay.seedReplayValue)}`)
console.log(`  live events:      ${replay.liveEventTypes.join(' -> ')}`)
console.log(`  replay events:    ${replay.replayEventTypes.join(' -> ')}`)
console.log(`  onChanged seq:    ${replay.changes.map(change => change.seq).join(', ')}`)

const mutation = await runMutationSilenceScenario()
assert.equal(mutation.sameStateReference, true)
assert.deepEqual(mutation.beforeTodos, [])
assert.deepEqual(mutation.afterTodos, [
  { content: '状态已改变，通知却沉默', status: 'in_progress' },
])
assert.equal(mutation.changes.length, 0)

console.log('\nPASS 2/2：负向探针捕获“原地修改导致通知沉默”')
console.log(`  before:           ${JSON.stringify(mutation.beforeTodos)}`)
console.log(`  after:            ${JSON.stringify(mutation.afterTodos)}`)
console.log(`  same reference:   ${mutation.sameStateReference}`)
console.log(`  onChanged count:  ${mutation.changes.length}`)
