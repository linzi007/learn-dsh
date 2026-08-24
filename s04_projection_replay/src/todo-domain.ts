import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'

export const TODO_PROJECTION_KEY = 'course/todos' as const

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'course/todos': TodoItem[]
  }

  interface SessionProjectionMap {
    'course/todos': TodoItem[]
  }
}

const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

export const todoStateSchema: z.ZodType<TodoItem[]> = z.array(todoItemSchema)

export type TodoProjectionDefinition =
  & Omit<ProjectionDefinition<'course/todos', TodoItem[]>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'course/todos', TodoItem[]>['wire']> }

const todoWire: TodoProjectionDefinition['wire'] = {
  viewSchema: todoStateSchema,
  view: state => state.map(todo => ({ ...todo })),
}

/**
 * 正确单元：todo/write 携带完整列表，最新 whole value 胜出；
 * turn/start、turn/end 等无关事件返回原引用。
 */
export const todoProjection: TodoProjectionDefinition = {
  key: TODO_PROJECTION_KEY,
  stateSchema: todoStateSchema,
  init: () => [],
  apply: (state, event) => {
    if (event.type !== 'todo/write') return state
    return event.data.todos.map(todo => ({ ...todo }))
  },
  wire: todoWire,
  stateVersion: 1,
}

/**
 * 教学负例：值虽然变化，却原地修改并返回同一个引用。
 * Registry 用 Object.is 判断变化，因此这种写法会吞掉 onChanged。
 */
export function createMutatingTodoProjection(): TodoProjectionDefinition {
  return {
    key: TODO_PROJECTION_KEY,
    stateSchema: todoStateSchema,
    init: () => [],
    apply: (state, event) => {
      if (event.type !== 'todo/write') return state
      state.splice(0, state.length, ...event.data.todos.map(todo => ({ ...todo })))
      return state
    },
    wire: todoWire,
    stateVersion: 1,
  }
}

/** 从 init 开始，用同一个 definition 对整段事件日志做纯 fold。 */
export function manualFullFold(
  definition: TodoProjectionDefinition,
  events: readonly SessionEvent[],
): TodoItem[] {
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return state
}

/** 使用 definition 自己的 wire 规则得到可对外比较的领域值。 */
export function todoViewOf(
  definition: TodoProjectionDefinition,
  state: TodoItem[],
): TodoItem[] {
  return definition.wire.viewSchema.parse(definition.wire.view(state))
}
