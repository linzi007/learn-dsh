import assert from 'node:assert/strict'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-in-process-driver'
import {
  runAgentCapScenario,
  runMissingStructuredScenario,
  runPositiveWorkflowScenario,
} from './subagent-workflow-lab.ts'

const positive = await runPositiveWorkflowScenario()
assert.deepEqual(positive.result, {
  value: {
    candidate: 'release-candidate-17',
    summary: '候选摘要：测试通过，变更说明齐全。',
    verdict: 'ship',
    checks: ['tests', 'release-notes'],
  },
  stopReason: 'completed',
  agentsStarted: 2,
})
assert.equal(positive.parentMarkerSeenByParent, true)
assert.equal(positive.parentMarkerLeakedToChildren, false)
assert.equal(positive.plainChildTools.includes(STRUCTURED_OUTPUT_TOOL), false)
assert.equal(positive.structuredChildTools.includes(STRUCTURED_OUTPUT_TOOL), true)
assert.deepEqual(positive.structuredToolParameters, {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ship', 'hold'] },
    checks: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'checks'],
  additionalProperties: false,
})
assert.equal(positive.structuredToolNeverRegisteredGlobally, true)
assert.equal(positive.summaryReachedStructuredChild, true)
assert.equal(positive.childrenMissingAfterRunDispose, true)
assert.equal(positive.childSessionsMissingAfterRunDispose, true)
assert.equal(positive.parentAliveAfterRunDispose, true)

const missing = await runMissingStructuredScenario()
assert.equal(missing.result.stopReason, 'completed')
assert.deepEqual(missing.result.value, { scriptObserved: 'null' })
assert.equal(missing.modelRequestCount, 1)
assert.equal(missing.structuredToolWasAdvertised, true)
assert.equal(missing.childrenMissingAfterRunDispose, true)

const capped = await runAgentCapScenario()
assert.equal(capped.result.stopReason, 'error')
assert.equal(capped.result.agentsStarted, 1)
assert.match(capped.result.error ?? '', /total agent cap \(1\)/)
assert.equal(capped.modelRequestCount, 1)
assert.equal(capped.childrenMissingAfterRunDispose, true)

console.log('S12 PASS: real worker workflow drove plain + structured spawn children')
console.log('positive:', [
  positive.result.stopReason,
  `agents=${positive.result.agentsStarted}`,
  `children=${positive.childIds.length}`,
  `parentTranscriptLeaked=${positive.parentMarkerLeakedToChildren}`,
  `childrenRemaining=${positive.childrenMissingAfterRunDispose ? 0 : 'unexpected'}`,
].join(' -> '))
console.log('missing structured_output:', [
  `requests=${missing.modelRequestCount}`,
  `script=${JSON.stringify(missing.result.value)}`,
  `workflow=${missing.result.stopReason}`,
].join(' -> '))
console.log('agent cap:', [
  `agents=${capped.result.agentsStarted}`,
  capped.result.stopReason,
  capped.result.error?.split('\n', 1)[0],
].join(' -> '))
