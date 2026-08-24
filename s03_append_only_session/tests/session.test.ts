import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { runAppendOnlyScenario } from '../src/session-lab.ts'

describe('第 3 章：Append-only session', () => {
  it('为已接受事件分配从零开始的连续 seq', () => {
    const result = runAppendOnlyScenario()

    expect(result.finalSnapshot.map(event => event.seq)).toEqual([0, 1, 2])
    expect(result.events.start.seq).toBe(0)
    expect(result.events.todo.seq).toBe(1)
    expect(result.events.end.seq).toBe(2)
    expect(result.finalNextSeq).toBe(result.finalSnapshot.length)
    expect(result.seqContiguous).toBe(true)
  })

  it('快照并深度冻结已接受的事件数据', () => {
    const result = runAppendOnlyScenario()
    const loggedTodo = result.events.todo.data.todos[0]!

    expect(result.callerTodoContent).toBe('caller mutated')
    expect(result.loggedTodoContent).toBe('understand append-only')
    expect(Object.isFrozen(result.events.todo)).toBe(true)
    expect(Object.isFrozen(result.events.todo.data)).toBe(true)
    expect(Object.isFrozen(result.events.todo.data.todos)).toBe(true)
    expect(Object.isFrozen(loggedTodo)).toBe(true)
    expect(() => { loggedTodo.content = 'rewritten' }).toThrow(TypeError)
    expect(result.events.todo.data.todos[0]!.content).toBe('understand append-only')
  })

  it('让非法追加在提交前失败且不消耗 seq', () => {
    const result = runAppendOnlyScenario()

    expect(result.rejectedMessage).toMatch(/non-JSON-serializable data/)
    expect(result.nextSeqBeforeRejected).toBe(2)
    expect(result.nextSeqAfterRejected).toBe(2)
    expect(result.beforeSnapshot).toHaveLength(2)
    expect(result.afterRejectedSnapshot).toBe(result.beforeSnapshot)
    expect(result.sameSnapshotAfterRejected).toBe(true)
    expect(result.events.end.seq).toBe(result.nextSeqBeforeRejected)
  })

  it('返回冻结的缓存快照，成功追加后旧快照不增长', () => {
    const result = runAppendOnlyScenario()
    const writableSnapshot = result.beforeSnapshot as SessionEvent[]

    expect(Object.isFrozen(result.beforeSnapshot)).toBe(true)
    expect(() => writableSnapshot.push(result.events.start)).toThrow(TypeError)
    expect(result.snapshotBeforeCached).toBe(true)
    expect(result.beforeSnapshot).toHaveLength(2)
    expect(result.finalSnapshot).toHaveLength(3)
    expect(result.finalSnapshot).not.toBe(result.beforeSnapshot)
    expect(result.snapshotReplacedAfterCommit).toBe(true)
    expect(result.snapshotAfterCached).toBe(true)
  })

  it('输出可人工核对的确定性轨迹', () => {
    const result = runAppendOnlyScenario()

    expect(result.trace).toEqual([
      'append:turn/start seq=0',
      'append:todo/write seq=1',
      'snapshot:length=2 frozen=true cached=true',
      'recorded:understand append-only',
      'invalid:rejected message=session event "todo/write" carries non-JSON-serializable data',
      'after-invalid:length=2 seq=2 same-snapshot=true',
      'append:turn/end seq=2',
      'snapshots:old=2 new=3 replaced=true',
      'seq-contiguous=true',
    ])
  })
})
