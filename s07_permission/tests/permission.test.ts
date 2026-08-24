import { beforeAll, describe, expect, it } from 'vitest'
import {
  DRAFT_CALL_ID,
  PUBLISH_ALLOWED_CALL_ID,
  PUBLISH_REJECTED_CALL_ID,
  SYSTEM_CALL_ID,
  runNeverPolicyScenario,
  runNoAnswererScenario,
  runPermissionScenario,
  type PermissionScenarioResult,
  type ToolResultObservation,
} from '../src/permission-lab.ts'
import {
  PUBLISH_APPROVAL_REASON,
  SYSTEM_DENIAL_REASON,
} from '../src/permission-policy.ts'

let main: PermissionScenarioResult
let noAnswerer: PermissionScenarioResult
let never: PermissionScenarioResult

beforeAll(async () => {
  [main, noAnswerer, never] = await Promise.all([
    runPermissionScenario(),
    runNoAnswererScenario(),
    runNeverPolicyScenario(),
  ])
})

function resultFor(
  scenario: PermissionScenarioResult,
  callId: string,
): ToolResultObservation {
  const result = scenario.toolResults.find(candidate => candidate.callId === callId)
  if (result === undefined) throw new Error(`missing tool result for ${callId}`)
  return result
}

describe('第 7 章：Permission policy 与一次性 Approval', () => {
  it('draft 通过 next 委托，publish ask，system deny，只有获准调用进入工具 body', () => {
    expect(main.policy).toEqual([
      { callId: String(DRAFT_CALL_ID), target: 'draft', decision: 'allow-via-next' },
      { callId: String(PUBLISH_ALLOWED_CALL_ID), target: 'publish', decision: 'ask' },
      { callId: String(PUBLISH_REJECTED_CALL_ID), target: 'publish', decision: 'ask' },
      { callId: String(SYSTEM_CALL_ID), target: 'system', decision: 'deny' },
    ])

    expect(main.workspaceWrites).toEqual([
      { revision: 1, target: 'draft', content: '仅保存草稿' },
      { revision: 2, target: 'publish', content: '第一次发布' },
    ])
    expect(resultFor(main, String(DRAFT_CALL_ID)).isError).toBe(false)
    expect(resultFor(main, String(PUBLISH_ALLOWED_CALL_ID)).isError).toBe(false)
    expect(resultFor(main, String(PUBLISH_REJECTED_CALL_ID))).toMatchObject({
      isError: true,
      text: 'Error: the user rejected tool "course_write"',
    })
    expect(resultFor(main, String(SYSTEM_CALL_ID))).toMatchObject({
      isError: true,
      text: `Error: ${SYSTEM_DENIAL_REASON}`,
    })
  })

  it('allowed-once 不会记忆授权：第二次 publish 重新 ask，并可被 rejected', () => {
    expect(main.answererCalls).toBe(2)
    expect(main.approvalAnswers).toEqual([
      {
        callId: String(PUBLISH_ALLOWED_CALL_ID),
        toolName: 'course_write',
        reason: PUBLISH_APPROVAL_REASON,
        outcome: 'allowed-once',
      },
      {
        callId: String(PUBLISH_REJECTED_CALL_ID),
        toolName: 'course_write',
        reason: PUBLISH_APPROVAL_REASON,
        outcome: 'rejected',
      },
    ])
    expect(new Set(main.approvalAudit.map(pair => pair.approvalId)).size).toBe(2)
    expect(main.approvalAudit.map(pair => [pair.callId, pair.outcome])).toEqual([
      [String(PUBLISH_ALLOWED_CALL_ID), 'allowed-once'],
      [String(PUBLISH_REJECTED_CALL_ID), 'rejected'],
    ])
  })

  it('每次 publish 都留下 tool/call → asked → decided → tool/result 配对', () => {
    expect(main.approvalAudit).toHaveLength(2)
    for (const pair of main.approvalAudit) {
      expect(pair.trace).toEqual([
        'tool/call',
        'approval/asked',
        'approval/decided',
        'tool/result',
      ])
      expect(pair.seqs).toEqual([...pair.seqs].sort((left, right) => left - right))
      expect(new Set(pair.seqs).size).toBe(4)
    }

    const auditedCallIds = main.approvalAudit.map(pair => pair.callId)
    expect(auditedCallIds).not.toContain(String(DRAFT_CALL_ID))
    expect(auditedCallIds).not.toContain(String(SYSTEM_CALL_ID))
  })

  it('审批发生在真实 open turn 内，五个 Step 最终 completed → idle', () => {
    const turnStart = main.events.find(event => event.type === 'turn/start')
    const turnEnd = [...main.events].reverse().find(event => event.type === 'turn/end')
    if (turnStart?.type !== 'turn/start' || turnEnd?.type !== 'turn/end') {
      throw new Error('missing turn boundary')
    }

    expect(main.requests).toHaveLength(5)
    expect(main.events
      .filter(event => event.type === 'step/start')
      .map(event => event.type === 'step/start' && event.data.step))
      .toEqual([1, 2, 3, 4, 5])
    expect(main.approvalAudit.every(pair =>
      pair.seqs[0] !== undefined
      && pair.seqs.at(-1) !== undefined
      && pair.seqs[0] > turnStart.seq
      && (pair.seqs.at(-1) as number) < turnEnd.seq)).toBe(true)
    expect(main.turnEndReason.kind).toBe('completed')
    expect(main.statusBeforeDispose).toBe('idle')
  })

  it('ask 没有 answerer 时立即 unavailable 并 fail closed', () => {
    expect(noAnswerer.answererCalls).toBe(0)
    expect(noAnswerer.workspaceWrites).toEqual([])
    expect(noAnswerer.approvalAudit).toHaveLength(1)
    expect(noAnswerer.approvalAudit[0]).toMatchObject({
      outcome: 'unavailable',
      trace: ['tool/call', 'approval/asked', 'approval/decided', 'tool/result'],
    })
    expect(noAnswerer.toolResults[0]).toMatchObject({
      isError: true,
      text: 'Error: tool "course_write" requires approval, but no approval channel is available',
    })
    expect(noAnswerer.turnEndReason.kind).toBe('completed')
    expect(noAnswerer.statusBeforeDispose).toBe('idle')
  })

  it('policy never 在 answerer 之前 rejected，已注册 answerer 也不会调用', () => {
    expect(never.answererCalls).toBe(0)
    expect(never.workspaceWrites).toEqual([])
    expect(never.policy).toMatchObject([{ target: 'publish', decision: 'ask' }])
    expect(never.approvalAudit).toHaveLength(1)
    expect(never.approvalAudit[0]).toMatchObject({ outcome: 'rejected' })
    expect(never.toolResults[0]).toMatchObject({
      isError: true,
      text: 'Error: the user rejected tool "course_write"',
    })
    expect(never.turnEndReason.kind).toBe('completed')
    expect(never.statusBeforeDispose).toBe('idle')
  })
})
