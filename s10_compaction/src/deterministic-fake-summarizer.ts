import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type {
  ContentBlock,
  Message,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'

/**
 * 这里不是模型提供方：名字故意带 FAKE，避免把确定性课程替身误认成真实摘要器。
 */
export const FAKE_SUMMARIZER_PROVIDER = 'course-deterministic-fake'
export const FAKE_SUMMARIZER_MODEL = 'fixed-summary-v1'
export const FAKE_SUMMARY_TEXT = '[教学 FAKE 摘要] 已保留较早对话中的课程目标与关键决定。'
export const FAKE_SUMMARIZER_FAILURE = 'course deterministic fake summarizer failed'

/** 与上游 protected summarize seam 结构相同的最小输入形状。 */
interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}
export interface FakeSummarizerCall {
  readonly input: SummarizationInput
  readonly signalWasAbortedAtEntry: boolean
}

/**
 * 教学用 deterministic fake summarizer。
 *
 * 只有这个 protected hook 是替身；范围选择、token 计量、事务事件、
 * surface replace、flush 与 resume 都继续由真实 BasicCompactionEngine 完成。
 */
export class DeterministicFakeSummarizerCompactionEngine extends BasicCompactionEngine {
  readonly calls: FakeSummarizerCall[] = []
  private nextFailure: Error | undefined

  /** 让下一次摘要稳定失败，用于验证真实 provider 的 fail-closed 事务。 */
  failNextSummary(message = FAKE_SUMMARIZER_FAILURE): void {
    this.nextFailure = new Error(message)
  }

  protected override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted()
    this.calls.push({
      input: structuredClone(input),
      signalWasAbortedAtEntry: signal?.aborted ?? false,
    })

    const failure = this.nextFailure
    this.nextFailure = undefined
    if (failure !== undefined) throw failure

    const summary: ContentBlock[] = [{ type: 'text', text: FAKE_SUMMARY_TEXT }]
    return {
      summary,
      provider: FAKE_SUMMARIZER_PROVIDER,
      model: FAKE_SUMMARIZER_MODEL,
    }
  }
}
