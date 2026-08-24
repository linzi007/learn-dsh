import {
  LlmAdapter,
  LlmError,
  type CallId,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

export const SCRIPTED_PROVIDER = 'course-scripted' as const
export const SCRIPTED_MODEL = 'course-scripted-model' as const

/**
 * 一次模型请求对应的一段流，或一段根据真实请求现场生成的流。
 *
 * 函数形态让后续响应能够读取前一步写回的 tool-result，而不是把答案写死。
 */
export type ScriptStep =
  | readonly StreamChunk[]
  | ((request: GenerateOptions) => readonly StreamChunk[])

export interface ScriptedLlmAdapterOptions {
  /** 重复最后一步，用于有意构造跨请求不终止的负向探针。 */
  readonly repeatLast?: boolean
}

/**
 * 课程唯一替身边界：不访问网络、按脚本返回公开 StreamChunk 协议的 LLM adapter。
 * AgentLoop、Session、ToolRuntime 与 course_add 都使用真实实现。
 */
export class ScriptedLlmAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private cursor = 0

  constructor(
    private readonly script: readonly ScriptStep[],
    private readonly options: ScriptedLlmAdapterOptions = {},
  ) {
    super()
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(options)

    const step = this.script[this.cursor]
      ?? (this.options.repeatLast ? this.script.at(-1) : undefined)
    this.cursor += 1
    if (step === undefined) {
      throw new LlmError(
        `scripted LLM has no response for request ${this.cursor}`,
        'SCRIPT_EXHAUSTED',
      )
    }

    const chunks = typeof step === 'function' ? step(options) : step
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** 构造一个完整、合法的文本响应流。 */
export function textResponse(text: string): readonly StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    {
      type: 'usage',
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** 构造一个完整、合法的工具调用响应流。 */
export function toolCallResponse(
  callId: CallId,
  name: string,
  argumentsValue: unknown,
): readonly StreamChunk[] {
  const argumentsText = JSON.stringify(argumentsValue)
  if (argumentsText === undefined) {
    throw new TypeError('tool call arguments must be JSON-serializable')
  }

  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'tool-call-delta',
      index: 0,
      id: callId,
      name,
      argumentsDelta: argumentsText,
    },
    {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: callId,
        name,
        arguments: argumentsText,
      },
    },
    {
      type: 'usage',
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}
