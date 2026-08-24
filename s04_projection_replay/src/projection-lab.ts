import { Context } from '@deepseek-ai/cordis'
import {
  Session,
  SessionId,
  SessionStore,
  type TodoItem,
} from '@deepseek-ai/dsh-session'
import {
  SessionProjectionRegistry,
  type ProjectionSnapshot,
} from '@deepseek-ai/dsh-session-projection'
import {
  TODO_PROJECTION_KEY,
  createMutatingTodoProjection,
  manualFullFold,
  todoProjection,
  todoStateSchema,
  todoViewOf,
  type TodoProjectionDefinition,
} from './todo-domain.ts'

export interface TodoChange {
  readonly sessionId: string
  readonly key: typeof TODO_PROJECTION_KEY
  readonly seq: number
  readonly value: readonly TodoItem[]
}

export interface ProjectionReplayResult {
  readonly incrementalValue: readonly TodoItem[]
  readonly manualFullFoldValue: readonly TodoItem[]
  readonly seedReplayValue: readonly TodoItem[]
  readonly liveAsOfSeq: number
  readonly replayAsOfSeq: number
  readonly liveEventTypes: readonly string[]
  readonly replayEventTypes: readonly string[]
  readonly changes: readonly TodoChange[]
}

export interface MutationSilenceResult {
  readonly beforeTodos: readonly TodoItem[]
  readonly afterTodos: readonly TodoItem[]
  readonly snapshotValue: readonly TodoItem[]
  readonly sameStateReference: boolean
  readonly changes: readonly TodoChange[]
}

/**
 * 挂载真实 SessionStore 与 SessionProjectionRegistry。
 * definition 注册在根 fiber 上；初始化失败和调用方结束时都清理 root。
 */
export async function createProjectionHarness(
  definition: TodoProjectionDefinition = todoProjection,
): Promise<Context> {
  const root = new Context()
  try {
    await root.plugin(SessionStore)
    await root.plugin(SessionProjectionRegistry)
    root.sessionProjections.register(definition)
    return root
  } catch (error: unknown) {
    await root.fiber.dispose()
    throw error
  }
}

function collectTodoChanges(root: Context): TodoChange[] {
  const changes: TodoChange[] = []
  root.sessionProjections.onChanged((session, key, value, seq) => {
    if (key !== TODO_PROJECTION_KEY) return
    changes.push({
      sessionId: String(session.id),
      key,
      seq,
      value: todoStateSchema.parse(value),
    })
  })
  return changes
}

function todoValueFrom(snapshot: ProjectionSnapshot): TodoItem[] {
  const value = snapshot.values[TODO_PROJECTION_KEY]
  if (value === undefined) throw new Error('course/todos projection is not registered')
  return todoStateSchema.parse(value)
}

/**
 * 同一领域值的三条计算路径：live incremental、manual full fold、seed replay。
 */
export async function runProjectionReplayScenario(): Promise<ProjectionReplayResult> {
  const root = await createProjectionHarness()

  try {
    const changes = collectTodoChanges(root)
    const live = root.sessions.create(SessionId('s04-live'))

    live.append('turn/start', { turn: 1 })
    live.append('todo/write', {
      todos: [{ content: 'understand append-only', status: 'pending' }],
    })
    live.append('todo/write', {
      todos: [
        { content: 'understand append-only', status: 'completed' },
        { content: 'replay projection', status: 'in_progress' },
      ],
    })
    live.append('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    })

    const liveSnapshot = root.sessionProjections.snapshot(live)
    const incrementalValue = todoValueFrom(liveSnapshot)

    const foldedState = manualFullFold(todoProjection, live.events)
    const manualFullFoldValue = todoViewOf(todoProjection, foldedState)

    // Session.create(id, seed) 是 detached replay/fork 边界。本实验 seed 的
    // 最后一项不是 session/end-seed，因此构造器会在末尾追加该 marker。
    const replay = Session.create(
      SessionId('s04-seed-replay'),
      structuredClone(live.events),
    )
    const replaySnapshot = root.sessionProjections.snapshot(replay)
    const seedReplayValue = todoValueFrom(replaySnapshot)

    return {
      incrementalValue,
      manualFullFoldValue,
      seedReplayValue,
      liveAsOfSeq: liveSnapshot.asOfSeq,
      replayAsOfSeq: replaySnapshot.asOfSeq,
      liveEventTypes: live.events.map(event => event.type),
      replayEventTypes: replay.events.map(event => event.type),
      changes,
    }
  } finally {
    await root.fiber.dispose()
  }
}

/** 运行“值变了但通知沉默”的反例。 */
export async function runMutationSilenceScenario(): Promise<MutationSilenceResult> {
  const root = await createProjectionHarness(createMutatingTodoProjection())

  try {
    const session = root.sessions.create(SessionId('s04-mutation-silence'))
    const initialState = root.sessionProjections.stateOf(session, TODO_PROJECTION_KEY)
    if (initialState === undefined) throw new Error('course/todos projection is not registered')
    const beforeTodos = structuredClone(initialState)
    const changes = collectTodoChanges(root)

    session.append('todo/write', {
      todos: [{ content: '状态已改变，通知却沉默', status: 'in_progress' }],
    })

    const finalState = root.sessionProjections.stateOf(session, TODO_PROJECTION_KEY)
    if (finalState === undefined) throw new Error('course/todos projection disappeared')

    return {
      beforeTodos,
      afterTodos: structuredClone(finalState),
      snapshotValue: todoValueFrom(root.sessionProjections.snapshot(session)),
      sameStateReference: Object.is(initialState, finalState),
      changes,
    }
  } finally {
    await root.fiber.dispose()
  }
}
