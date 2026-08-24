import type { Context, Plugin } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

export const COURSE_WRITE_TOOL_NAME = 'course_write' as const
export const COURSE_WRITE_TARGETS = ['draft', 'publish', 'system'] as const

export type CourseWriteTarget = typeof COURSE_WRITE_TARGETS[number]

export interface CourseWriteRecord {
  readonly revision: number
  readonly target: CourseWriteTarget
  readonly content: string
}

/**
 * 教学用内存工作区。它只记录调用，不接触文件系统、网络或进程权限。
 * 因此本章观察的是“工具 body 是否被 dispatch”，不是 OS sandbox。
 */
export class MemoryCourseWorkspace {
  private readonly records: CourseWriteRecord[] = []

  write(target: CourseWriteTarget, content: string): CourseWriteRecord {
    const record = Object.freeze({
      revision: this.records.length + 1,
      target,
      content,
    })
    this.records.push(record)
    return record
  }

  snapshot(): CourseWriteRecord[] {
    return this.records.map(record => ({ ...record }))
  }
}

/** 为一个内存工作区构造正式的 Tool Definition。 */
export function createCourseWriteTool(workspace: MemoryCourseWorkspace): ToolDefinition {
  return defineTool({
    name: COURSE_WRITE_TOOL_NAME,
    description: '把文本写入课程内存工作区；target 表示 draft、publish 或 system。',
    parameters: {
      target: {
        type: 'string',
        required: true,
        enum: [...COURSE_WRITE_TARGETS],
        description: 'draft 可直接写；publish 需审批；system 被课程 policy 拒绝。',
      },
      content: {
        type: 'string',
        required: true,
        description: '要写入的文本。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          revision: { type: 'integer', required: true },
          target: {
            type: 'string',
            required: true,
            enum: [...COURSE_WRITE_TARGETS],
          },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `内存写入成功：${value.target}#${value.revision} ${value.content}`,
      }],
    },
    execute(args) {
      return Promise.resolve(workspace.write(args.target, args.content))
    },
  })
}

/** 注册 course_write；Tool 与内存状态都由调用方 Context 生命周期拥有。 */
export function createCourseWriteToolPlugin(
  workspace: MemoryCourseWorkspace,
): Plugin.Object {
  return {
    name: 'course-write-tool',
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.tools.register(createCourseWriteTool(workspace))
    },
  }
}
