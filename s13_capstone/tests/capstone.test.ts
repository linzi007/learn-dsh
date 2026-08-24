import { beforeAll, describe, expect, it } from 'vitest'
import {
  A_EDIT_CALL_ID,
  A_READ_CALL_ID,
  B_DIRECT_EDIT_CALL_ID,
  B_OUTSIDE_WRITE_CALL_ID,
  B_READ_CALL_ID,
  B_RETRY_EDIT_CALL_ID,
  B_SYMLINK_READ_CALL_ID,
  runCapstoneScenario,
  type CapstoneScenarioResult,
  type ToolResultObservation,
} from '../src/capstone-lab.ts'
import {
  CONTEXT_A_COURSE_CONTENT,
  FINAL_COURSE_CONTENT,
} from '../src/capstone-fixtures.ts'
import {
  MUTATION_APPROVAL_REASON,
  WORKSPACE_DENIAL_REASON,
} from '../src/workspace-policy.ts'

let scenario: CapstoneScenarioResult

beforeAll(async () => {
  scenario = await runCapstoneScenario()
})

function resultFor(callId: string): ToolResultObservation {
  const result = scenario.toolResults.find(candidate => candidate.callId === callId)
  if (result === undefined) throw new Error(`missing S13 tool result for ${callId}`)
  return result
}

describe('第 13 章：keyless mini coding harness', () => {
  it('Context A flush/dispose 后，Context B 从同一 durable Session 继续 Turn 2', () => {
    expect(scenario.contextAFlushObserved).toBe(true)
    expect(scenario.contextBFlushObserved).toBe(true)
    expect(scenario.contextAStatus).toBe('idle')
    expect(scenario.contextBStatus).toBe('idle')
    expect(scenario.contextACwd).toBe(scenario.workspace)
    expect(scenario.contextBCwd).toBe(scenario.workspace)
    expect(scenario.artifactFilename).toBe('session.jsonl')

    expect(scenario.durableEventsAfterContextA).toEqual(scenario.contextAEvents)
    expect(scenario.firstLiveSeq).toBe(scenario.contextAEvents.length)
    expect(scenario.resumedEventsBeforeContextB.slice(0, scenario.firstLiveSeq))
      .toEqual(scenario.contextAEvents)
    expect(scenario.resumedEventsBeforeContextB[scenario.firstLiveSeq]).toMatchObject({
      type: 'session/end-seed',
      seq: scenario.firstLiveSeq,
    })
    expect(scenario.turnNumbers).toEqual([1, 2])
    expect(scenario.durableEventsAfterContextB).toEqual(scenario.finalEvents)
  })

  it('Context A 用真实 read 建立观察后，edit 获批并改动真实课程文件', () => {
    expect(scenario.contextARequests).toHaveLength(3)
    expect(scenario.contextAPolicy.map(observation => ({
      callId: observation.callId,
      decision: observation.decision,
    }))).toEqual([
      { callId: String(A_READ_CALL_ID), decision: 'allow-via-next' },
      { callId: String(A_EDIT_CALL_ID), decision: 'ask' },
    ])
    expect(resultFor(String(A_READ_CALL_ID)).isError).toBe(false)
    expect(resultFor(String(A_EDIT_CALL_ID)).isError).toBe(false)
    expect(scenario.courseContentAfterContextA).toBe(CONTEXT_A_COURSE_CONTENT)
    expect(scenario.contextAFinalText).toContain(resultFor(String(A_EDIT_CALL_ID)).text)
  })

  it('恢复 transcript 不恢复 observation cache：直接 edit 以 FS_NOT_OBSERVED 拒绝', () => {
    const direct = resultFor(String(B_DIRECT_EDIT_CALL_ID))
    expect(direct).toMatchObject({
      toolName: 'edit',
      isError: true,
      errorCode: 'FS_NOT_OBSERVED',
    })
    expect(direct.text).toContain('requires reading')
    expect(direct.text).toContain('read the file, then retry')
    expect(scenario.dispatchedCallIds).toContain(String(B_DIRECT_EDIT_CALL_ID))
  })

  it('Context B 重新 read 后，同一 edit 再次获批并成功落盘', () => {
    expect(scenario.contextBRequests).toHaveLength(6)
    expect(resultFor(String(B_READ_CALL_ID)).isError).toBe(false)
    expect(resultFor(String(B_RETRY_EDIT_CALL_ID))).toMatchObject({
      toolName: 'edit',
      isError: false,
      errorCode: undefined,
    })
    expect(scenario.finalCourseContent).toBe(FINAL_COURSE_CONTENT)
    expect(scenario.contextBFinalText).toContain(resultFor(String(B_DIRECT_EDIT_CALL_ID)).text)
    expect(scenario.contextBFinalText).toContain(resultFor(String(B_RETRY_EDIT_CALL_ID)).text)
  })

  it('每个允许进入 body 的 mutation 都单独 ask，并留下完整 allowed-once 审计', () => {
    expect(scenario.approvalAnswers).toEqual([
      {
        context: 'A',
        callId: String(A_EDIT_CALL_ID),
        toolName: 'edit',
        reason: MUTATION_APPROVAL_REASON,
        outcome: 'allowed-once',
      },
      {
        context: 'B',
        callId: String(B_DIRECT_EDIT_CALL_ID),
        toolName: 'edit',
        reason: MUTATION_APPROVAL_REASON,
        outcome: 'allowed-once',
      },
      {
        context: 'B',
        callId: String(B_RETRY_EDIT_CALL_ID),
        toolName: 'edit',
        reason: MUTATION_APPROVAL_REASON,
        outcome: 'allowed-once',
      },
    ])
    expect(scenario.approvalAudit.map(audit => [audit.callId, audit.outcome])).toEqual([
      [String(A_EDIT_CALL_ID), 'allowed-once'],
      [String(B_DIRECT_EDIT_CALL_ID), 'allowed-once'],
      [String(B_RETRY_EDIT_CALL_ID), 'allowed-once'],
    ])
    for (const audit of scenario.approvalAudit) {
      expect(audit.trace).toEqual([
        'tool/call',
        'approval/asked',
        'approval/decided',
        'tool/result',
      ])
      expect(audit.seqs).toEqual([...audit.seqs].sort((left, right) => left - right))
    }
  })

  it('../outside.txt 在 pre-execute 阶段拒绝，不审批、不 dispatch、不改外部文件', () => {
    const outsideCallId = String(B_OUTSIDE_WRITE_CALL_ID)
    expect(scenario.contextBPolicy).toContainEqual(expect.objectContaining({
      callId: outsideCallId,
      toolName: 'write',
      requestedPath: '../outside.txt',
      insideWorkspace: false,
      decision: 'deny',
    }))
    expect(resultFor(outsideCallId)).toMatchObject({
      toolName: 'write',
      isError: true,
      text: `Error: ${WORKSPACE_DENIAL_REASON}`,
    })
    expect(scenario.approvalAnswers.map(answer => answer.callId)).not.toContain(outsideCallId)
    expect(scenario.dispatchedCallIds).not.toContain(outsideCallId)
    expect(scenario.outsideFixtureUnchanged).toBe(true)
  })

  it('symlink 指向 workspace 外时，realpath containment 同样在 read body 前拒绝', () => {
    const symlinkCallId = String(B_SYMLINK_READ_CALL_ID)
    expect(scenario.contextBPolicy).toContainEqual(expect.objectContaining({
      callId: symlinkCallId,
      toolName: 'read',
      requestedPath: 'escape-link.txt',
      insideWorkspace: false,
      decision: 'deny',
    }))
    expect(resultFor(symlinkCallId).text).toBe(`Error: ${WORKSPACE_DENIAL_REASON}`)
    expect(scenario.dispatchedCallIds).not.toContain(symlinkCallId)
    expect(scenario.outsideFixtureLeakedToTranscript).toBe(false)
  })

  it('两个 AgentHandle、Session 和精确 mkdtemp 根都完成清理', () => {
    expect(scenario.contextAAgentMissingAfterDispose).toBe(true)
    expect(scenario.contextASessionMissingAfterDispose).toBe(true)
    expect(scenario.contextBAgentMissingAfterDispose).toBe(true)
    expect(scenario.contextBSessionMissingAfterDispose).toBe(true)
    expect(scenario.tempRootRemoved).toBe(true)
  })
})
