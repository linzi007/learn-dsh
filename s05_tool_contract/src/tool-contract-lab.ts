import { Context, type Plugin } from '@deepseek-ai/cordis'
import { CallId, type ToolSchema } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, {
  type ToolDefinition,
  type ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import {
  COURSE_ADD_TOOL_NAME,
  courseAddTool,
  courseAddToolPlugin,
} from './course-add-tool.ts'

const INVALID_OUTPUT_TOOL_NAME = 'course_add_invalid_output_probe'

/**
 * 教学故障工具：复用正式工具的参数与 output contract，只把 body 换成错误类型。
 * 这是为了观察真实 Registry 的 runtime output validation，不是可复用产品工具。
 */
const invalidOutputTool: ToolDefinition = {
  ...courseAddTool,
  name: INVALID_OUTPUT_TOOL_NAME,
  description: '教学故障探针：故意返回不符合 output schema 的值。',
  execute() {
    return Promise.resolve({ sum: 'forty-two' })
  },
}

const invalidOutputToolPlugin = {
  name: 'course-add-invalid-output-probe',
  inject: ['tools'],
  apply(ctx: Context) {
    ctx.tools.register(invalidOutputTool)
  },
} satisfies Plugin.Object

export interface ToolResultObservation {
  readonly callId: string
  readonly name: string
  readonly isError: boolean
  readonly errorCode: string | null
  readonly content: string
}

export interface ToolContractScenarioResult {
  readonly registrySchema: ToolSchema
  readonly assembledSchema: ToolSchema
  readonly success: ToolExecutionResult
  readonly invalidArguments: ToolExecutionResult
  readonly invalidOutput: ToolExecutionResult
  readonly unknownAfterDispose: ToolExecutionResult
  readonly schemasAfterDispose: readonly string[]
  readonly observations: readonly ToolResultObservation[]
}

/** 挂载真实 SystemPrompt、ToolRuntime 与本章 Tool Plugin。 */
export async function createToolContractHarness() {
  const root = new Context()

  try {
    await root.plugin(SystemPrompt)
    await root.plugin(ToolRuntime, { mode: 'native' })

    const toolFiber = root.plugin(courseAddToolPlugin)
    await toolFiber.await()
    return { root, toolFiber }
  } catch (error: unknown) {
    await root.fiber.dispose()
    throw error
  }
}

function textContent(result: ToolExecutionResult): string {
  return result.content
    .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
    .join('')
}

function requireSchema(schemas: readonly ToolSchema[], name: string): ToolSchema {
  const schema = schemas.find(candidate => candidate.name === name)
  if (schema === undefined) throw new Error(`tool schema disappeared: ${name}`)
  return schema
}

async function runInvalidOutputProbe(root: Context): Promise<ToolExecutionResult> {
  const faultFiber = root.plugin(invalidOutputToolPlugin)
  try {
    await faultFiber.await()
    return await root.tools.execute({
      callId: CallId('s05-invalid-output'),
      name: INVALID_OUTPUT_TOOL_NAME,
      arguments: { left: 20, right: 22 },
      signal: new AbortController().signal,
    })
  } finally {
    await faultFiber.dispose()
  }
}

/**
 * 依次观察 schema presentation、成功结果、两种 contract failure 和注销后的未知工具。
 */
export async function runToolContractScenario(): Promise<ToolContractScenarioResult> {
  const { root, toolFiber } = await createToolContractHarness()

  try {
    const observations: ToolResultObservation[] = []
    root.on('tools/result', (exec, result) => {
      observations.push({
        callId: String(exec.callId),
        name: exec.name,
        isError: result.isError,
        errorCode: result.isError ? result.error.info?.code ?? null : null,
        content: textContent(result),
      })
    })

    const registrySchema = requireSchema(root.tools.schemas(), COURSE_ADD_TOOL_NAME)
    const assembly = await root.systemPrompt.assemble()
    const assembledSchema = requireSchema(assembly.tools, COURSE_ADD_TOOL_NAME)

    const success = await root.tools.execute({
      callId: CallId('s05-valid'),
      name: COURSE_ADD_TOOL_NAME,
      arguments: { left: 20, right: 22 },
      signal: new AbortController().signal,
    })

    const invalidArguments = await root.tools.execute({
      callId: CallId('s05-invalid-args'),
      name: COURSE_ADD_TOOL_NAME,
      arguments: { left: 20, right: '22' },
      signal: new AbortController().signal,
    })

    const invalidOutput = await runInvalidOutputProbe(root)

    await toolFiber.dispose()
    const schemasAfterDispose = root.tools.schemas().map(schema => schema.name)
    const unknownAfterDispose = await root.tools.execute({
      callId: CallId('s05-after-dispose'),
      name: COURSE_ADD_TOOL_NAME,
      arguments: { left: 20, right: 22 },
      signal: new AbortController().signal,
    })

    return {
      registrySchema,
      assembledSchema,
      success,
      invalidArguments,
      invalidOutput,
      unknownAfterDispose,
      schemasAfterDispose,
      observations,
    }
  } finally {
    await root.fiber.dispose()
  }
}
