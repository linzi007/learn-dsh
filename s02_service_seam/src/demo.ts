import assert from 'node:assert/strict'
import {
  runMissingInjectScenario,
  runServiceReplacementScenario,
} from './service-lab.ts'

const replacement = await runServiceReplacementScenario()
assert.deepEqual(replacement.activations, [
  '你好，learner！',
  'Welcome, learner.',
])
assert.deepEqual(
  replacement.checkpoints.map(checkpoint => checkpoint.providerClass),
  [null, 'FriendlyGreeterProvider', null, 'FormalGreeterProvider', null],
)
assert.deepEqual(
  replacement.checkpoints.map(checkpoint => checkpoint.effects.length),
  [0, 1, 0, 1, 0],
)

console.log('PASS 1/2：同一个 Consumer 跟随两个 Provider class 启停')
for (const checkpoint of replacement.checkpoints) {
  console.log(
    `  ${checkpoint.step}: provider=${checkpoint.providerClass ?? 'none'} effects=${checkpoint.effects.length}`,
  )
}
for (const event of replacement.trace) console.log(`  ${event}`)

const missingInject = await runMissingInjectScenario()
assert.equal(missingInject.applyCount, 1)
assert.match(missingInject.errorMessage, /without inject/)

console.log('\nPASS 2/2：负向探针捕获缺失 inject 的直接属性访问')
for (const event of missingInject.trace) console.log(`  ${event}`)
