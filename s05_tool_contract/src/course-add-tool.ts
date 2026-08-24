import type { Context, Plugin } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const COURSE_ADD_TOOL_NAME = 'course_add' as const

/**
 * 本章唯一正式工具定义：参数 schema、canonical output 与 renderer 在同一处声明。
 * 该定义没有可变状态，可以由 S06 的真实 AgentLoop composition 直接复用。
 */
export const courseAddTool = defineTool({
  name: COURSE_ADD_TOOL_NAME,
  description: '将两个整数相加，并返回结构化的和。',
  parameters: {
    left: { type: 'integer', required: true, description: '左侧整数。' },
    right: { type: 'integer', required: true, description: '右侧整数。' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sum: { type: 'integer', required: true },
      },
    },
    render: (args, value) => [{
      type: 'text',
      text: `计算结果：${args.left} + ${args.right} = ${value.sum}`,
    }],
  },
  execute(args) {
    return Promise.resolve({ sum: args.left + args.right })
  },
})

/** 真实 Tool Consumer：通过 tools Service 注册，并随调用方 Fiber 自动注销。 */
export const courseAddToolPlugin = {
  name: 'course-add-tool',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.tools.register(courseAddTool)
  },
} satisfies Plugin.Object
