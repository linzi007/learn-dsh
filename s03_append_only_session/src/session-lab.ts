import {
  Session,
  SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'

export interface AppendOnlyScenarioResult {
  readonly trace: readonly string[]
  readonly events: {
    readonly start: SessionEvent<'turn/start'>
    readonly todo: SessionEvent<'todo/write'>
    readonly end: SessionEvent<'turn/end'>
  }
  readonly beforeSnapshot: readonly SessionEvent[]
  readonly afterRejectedSnapshot: readonly SessionEvent[]
  readonly finalSnapshot: readonly SessionEvent[]
  readonly callerTodoContent: string
  readonly loggedTodoContent: string
  readonly rejectedMessage: string
  readonly nextSeqBeforeRejected: number
  readonly nextSeqAfterRejected: number
  readonly finalNextSeq: number
  readonly snapshotBeforeCached: boolean
  readonly snapshotAfterCached: boolean
  readonly sameSnapshotAfterRejected: boolean
  readonly snapshotReplacedAfterCommit: boolean
  readonly seqContiguous: boolean
}

/**
 * 使用真实 DSH Session 运行一次成功追加、失败追加和再次成功追加。
 */
export function runAppendOnlyScenario(): AppendOnlyScenarioResult {
  const trace: string[] = []
  const session = Session.create(SessionId('s03-demo'))

  const start = session.append('turn/start', { turn: 1 })
  trace.push(`append:${start.type} seq=${start.seq}`)

  const todoInput = {
    todos: [{ content: 'understand append-only', status: 'pending' as const }],
  }
  const todo = session.append('todo/write', todoInput)
  trace.push(`append:${todo.type} seq=${todo.seq}`)

  const beforeSnapshot = session.events
  const snapshotBeforeCached = session.events === beforeSnapshot
  trace.push(
    `snapshot:length=${beforeSnapshot.length} frozen=${Object.isFrozen(beforeSnapshot)} cached=${snapshotBeforeCached}`,
  )

  todoInput.todos[0]!.content = 'caller mutated'
  const loggedTodoContent = todo.data.todos[0]!.content
  trace.push(`recorded:${loggedTodoContent}`)

  const nextSeqBeforeRejected = session.seq
  let rejectedMessage: string | undefined
  try {
    // 故意绕过 TypeScript，验证持久化输入的 runtime 边界。
    session.append('todo/write', {
      todos: [],
      unsupported: 1n,
    } as never)
  } catch (error: unknown) {
    rejectedMessage = error instanceof Error ? error.message : String(error)
  }
  if (rejectedMessage === undefined) {
    throw new Error('negative probe unexpectedly accepted BigInt event data')
  }
  trace.push(`invalid:rejected message=${rejectedMessage}`)

  const afterRejectedSnapshot = session.events
  const nextSeqAfterRejected = session.seq
  const sameSnapshotAfterRejected = afterRejectedSnapshot === beforeSnapshot
  trace.push(
    `after-invalid:length=${afterRejectedSnapshot.length} seq=${nextSeqAfterRejected} same-snapshot=${sameSnapshotAfterRejected}`,
  )

  const end = session.append('turn/end', {
    turn: 1,
    reason: { kind: 'completed' },
  })
  trace.push(`append:${end.type} seq=${end.seq}`)

  const finalSnapshot = session.events
  const snapshotReplacedAfterCommit = finalSnapshot !== beforeSnapshot
  trace.push(
    `snapshots:old=${beforeSnapshot.length} new=${finalSnapshot.length} replaced=${snapshotReplacedAfterCommit}`,
  )

  const seqContiguous = finalSnapshot.every((event, index) => event.seq === index)
  trace.push(`seq-contiguous=${seqContiguous}`)

  return {
    trace,
    events: { start, todo, end },
    beforeSnapshot,
    afterRejectedSnapshot,
    finalSnapshot,
    callerTodoContent: todoInput.todos[0]!.content,
    loggedTodoContent,
    rejectedMessage,
    nextSeqBeforeRejected,
    nextSeqAfterRejected,
    finalNextSeq: session.seq,
    snapshotBeforeCached,
    snapshotAfterCached: session.events === finalSnapshot,
    sameSnapshotAfterRejected,
    snapshotReplacedAfterCommit,
    seqContiguous,
  }
}
