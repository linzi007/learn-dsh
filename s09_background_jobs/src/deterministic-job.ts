import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobHooks, JobOutcome, JobStart } from '@deepseek-ai/dsh-jobs'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    course: 'course'
  }
}

export interface DeterministicJobOptions {
  readonly label: string
  readonly owner?: Agent
  /** 负例专用：让 producer 的 cancel 违反正常协作路径并抛错。 */
  readonly cancelError?: string
}

type ProducerPhase = 'created' | 'running' | 'settled'

/**
 * 课程原创的可控 producer。
 *
 * 它只实现真实 JobStart / JobHooks 所要求的执行适配，不实现队列、调度器、
 * worker pool 或 JobRegistry。测试代码显式 push / complete，因而不需要 sleep。
 */
export class DeterministicJobProducer {
  readonly spec: JobStart
  readonly completion: Promise<JobOutcome>

  private phase: ProducerPhase = 'created'
  private unread = ''
  private resolveCompletion!: (outcome: JobOutcome) => void
  private readonly recordedCancellations: Array<string | undefined> = []

  constructor(private readonly options: DeterministicJobOptions) {
    this.completion = new Promise<JobOutcome>((resolve) => {
      this.resolveCompletion = resolve
    })
    this.spec = {
      kind: 'course',
      label: options.label,
      ...(options.owner === undefined ? {} : { owner: options.owner }),
      run: () => this.start(),
    }
  }

  get started(): boolean {
    return this.phase !== 'created'
  }

  get cancellations(): readonly (string | undefined)[] {
    return [...this.recordedCancellations]
  }

  push(text: string): void {
    if (this.phase !== 'running') {
      throw new Error(`cannot push output while producer is ${this.phase}`)
    }
    this.unread += text
  }

  complete(detail = 'course work completed'): void {
    this.settle({ status: 'completed', detail })
  }

  fail(detail: string): void {
    this.settle({ status: 'failed', detail })
  }

  private start(): JobHooks {
    if (this.phase !== 'created') throw new Error('deterministic producer can start only once')
    this.phase = 'running'

    return {
      cancel: reason => this.cancel(reason),
      done: this.completion,
      readOutput: () => this.readOutput(),
    }
  }

  private cancel(reason?: string): void {
    if (this.phase === 'settled') return
    if (this.options.cancelError !== undefined) {
      throw new Error(this.options.cancelError)
    }
    this.recordedCancellations.push(reason)
    this.settle({
      status: 'killed',
      detail: reason ?? 'cancellation requested',
    })
  }

  private readOutput(): string {
    const text = this.unread
    this.unread = ''
    return text
  }

  private settle(outcome: JobOutcome): void {
    if (this.phase === 'created') throw new Error('cannot settle a producer before start')
    if (this.phase === 'settled') return
    this.phase = 'settled'
    this.resolveCompletion(outcome)
  }
}
