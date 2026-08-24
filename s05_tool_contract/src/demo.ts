import assert from 'node:assert/strict'
import { runToolContractScenario } from './tool-contract-lab.ts'

const result = await runToolContractScenario()

assert.deepEqual(result.assembledSchema, result.registrySchema)
assert.equal(result.registrySchema.name, 'course_add')
assert.deepEqual(Object.keys(result.registrySchema).sort(), [
  'description',
  'name',
  'parameters',
])

assert.equal(result.success.isError, false)
if (result.success.isError) throw new Error('course_add unexpectedly failed')
assert.deepEqual(result.success.value, { sum: 42 })
assert.deepEqual(result.success.content, [{
  type: 'text',
  text: '计算结果：20 + 22 = 42',
}])

assert.equal(result.invalidArguments.isError, true)
if (!result.invalidArguments.isError) throw new Error('invalid arguments unexpectedly succeeded')
assert.equal(result.invalidArguments.error.info?.code, 'INVALID_ARGS')
assert.equal('value' in result.invalidArguments, false)

assert.equal(result.invalidOutput.isError, true)
if (!result.invalidOutput.isError) throw new Error('invalid output unexpectedly succeeded')
assert.equal(result.invalidOutput.error.info?.code, 'INVALID_TOOL_OUTPUT')
assert.equal('value' in result.invalidOutput, false)

assert.deepEqual(result.schemasAfterDispose, [])
assert.equal(result.unknownAfterDispose.isError, true)
if (!result.unknownAfterDispose.isError) throw new Error('disposed tool unexpectedly executed')
assert.equal(result.unknownAfterDispose.error.info?.code, 'UNKNOWN_TOOL')

console.log('PASS 1/4：同一 model-facing schema 同时来自 Registry 与 SystemPrompt assembly')
console.log(`  schema: ${JSON.stringify(result.registrySchema)}`)

console.log('\nPASS 2/4：有效参数得到 canonical value，再由 renderer 产生 content')
console.log(`  value:   ${JSON.stringify(result.success.value)}`)
console.log(`  content: ${JSON.stringify(result.success.content)}`)

console.log('\nPASS 3/4：参数错误与 body 输出错误被规范化成不同错误码')
console.log(`  invalid args:   ${result.invalidArguments.error.info?.code}`)
console.log(`  invalid output: ${result.invalidOutput.error.info?.code}`)

console.log('\nPASS 4/4：Tool Plugin Fiber dispose 后，注册消失且调用变成 UNKNOWN_TOOL')
console.log(`  schemas after dispose: ${JSON.stringify(result.schemasAfterDispose)}`)
console.log(`  disposed call:         ${result.unknownAfterDispose.error.info?.code}`)
console.log(`  observed calls:        ${result.observations.map(entry => `${entry.callId}:${entry.errorCode ?? 'OK'}`).join(' -> ')}`)
