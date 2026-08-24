import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  TODO_PROJECTION_KEY,
} from '../src/todo-domain.ts'
import {
  createProjectionHarness,
  runMutationSilenceScenario,
  runProjectionReplayScenario,
} from '../src/projection-lab.ts'

const expectedFinalTodos = [
  { content: 'understand append-only', status: 'completed' },
  { content: 'replay projection', status: 'in_progress' },
] as const

describe('第 4 章：Projection 与 replay', () => {
  it('空日志从 init 得到状态，watermark 为 -1', async () => {
    const root = await createProjectionHarness()

    try {
      const session = root.sessions.create(SessionId('s04-empty'))
      const snapshot = root.sessionProjections.snapshot(session)

      expect(snapshot.asOfSeq).toBe(-1)
      expect(snapshot.values[TODO_PROJECTION_KEY]).toEqual([])
    } finally {
      await root.fiber.dispose()
    }
  })

  it('第二次 whole-value 更新胜出，三条计算路径一致', async () => {
    const result = await runProjectionReplayScenario()

    expect(result.incrementalValue).toEqual(expectedFinalTodos)
    expect(result.manualFullFoldValue).toEqual(result.incrementalValue)
    expect(result.seedReplayValue).toEqual(result.incrementalValue)

    expect(result.liveAsOfSeq).toBe(3)
    expect(result.replayAsOfSeq).toBe(4)
    expect(result.liveEventTypes).toEqual([
      'turn/start',
      'todo/write',
      'todo/write',
      'turn/end',
    ])
    expect(result.replayEventTypes).toEqual([
      ...result.liveEventTypes,
      'session/end-seed',
    ])
  })

  it('只有两次 todo/write 产生通知，无关事件和 lazy fold 不通知', async () => {
    const result = await runProjectionReplayScenario()

    expect(result.changes).toEqual([
      {
        sessionId: 's04-live',
        key: TODO_PROJECTION_KEY,
        seq: 1,
        value: [{ content: 'understand append-only', status: 'pending' }],
      },
      {
        sessionId: 's04-live',
        key: TODO_PROJECTION_KEY,
        seq: 2,
        value: expectedFinalTodos,
      },
    ])
  })

  it('原地修改并返回同一引用时，状态改变但 onChanged 静默', async () => {
    const result = await runMutationSilenceScenario()

    expect(result.beforeTodos).toEqual([])
    expect(result.afterTodos).toEqual([
      { content: '状态已改变，通知却沉默', status: 'in_progress' },
    ])
    expect(result.snapshotValue).toEqual(result.afterTodos)
    expect(result.sameStateReference).toBe(true)
    expect(result.changes).toEqual([])
  })
})
