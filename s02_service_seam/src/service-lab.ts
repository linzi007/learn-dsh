import { Context, Service, type Plugin } from '@deepseek-ai/cordis'

export const GREETER_SERVICE_NAME = 'courseGreeter'

declare module '@deepseek-ai/cordis' {
  interface Context {
    courseGreeter: GreeterDefinition
  }
}

/**
 * Service Definition：只定义稳定能力，不包含任何具体 Provider 的配置。
 * declaration merging 只让 TypeScript 认识 ctx.courseGreeter；真正的运行时
 * 注册仍由构造器里的 super(ctx, GREETER_SERVICE_NAME) 完成。
 */
export abstract class GreeterDefinition extends Service {
  constructor(ctx: Context) {
    super(ctx, GREETER_SERVICE_NAME)
  }

  abstract greet(who: string): string
}

interface ProviderProbeConfig {
  trace: string[]
}

/** 第一个 Provider：友好中文问候。 */
export class FriendlyGreeterProvider extends GreeterDefinition {
  constructor(ctx: Context, config: ProviderProbeConfig) {
    super(ctx)
    config.trace.push('provider:constructed:friendly')
  }

  greet(who: string): string {
    return `你好，${who}！`
  }
}

/** 第二个 Provider：正式英文问候。它与第一个 Provider 是不同 class。 */
export class FormalGreeterProvider extends GreeterDefinition {
  constructor(ctx: Context, config: ProviderProbeConfig) {
    super(ctx)
    config.trace.push('provider:constructed:formal')
  }

  greet(who: string): string {
    return `Welcome, ${who}.`
  }
}

export interface ServiceCheckpoint {
  readonly step: 'waiting' | 'friendly' | 'missing' | 'formal' | 'complete'
  readonly trace: readonly string[]
  readonly effects: readonly string[]
  readonly providerClass: string | null
}

export interface ServiceReplacementResult {
  readonly trace: readonly string[]
  readonly activations: readonly string[]
  readonly checkpoints: readonly ServiceCheckpoint[]
}

export interface MissingInjectResult {
  readonly trace: readonly string[]
  readonly errorMessage: string
  readonly applyCount: number
}

/**
 * Consumer 只依赖 GreeterDefinition / service key，不 import 或判断具体 Provider。
 */
export function createGreeterConsumer(trace: string[], activations: string[]) {
  return {
    name: 'course-greeter-consumer',
    inject: [GREETER_SERVICE_NAME],
    apply(ctx: Context) {
      const greeting = ctx.courseGreeter.greet('learner')

      ctx.effect(() => {
        activations.push(greeting)
        trace.push(`consumer:start:${greeting}`)
        return () => {
          trace.push(`consumer:stop:${greeting}`)
        }
      }, 'course-greeter-consumer-lifetime')
    },
  } satisfies Plugin.Object
}

function takeCheckpoint(
  step: ServiceCheckpoint['step'],
  root: Context,
  consumer: ReturnType<Context['plugin']>,
  trace: readonly string[],
): ServiceCheckpoint {
  const provider = root.get(GREETER_SERVICE_NAME) as GreeterDefinition | undefined
  return {
    step,
    trace: [...trace],
    effects: consumer.getEffects().map(effect => effect.label),
    providerClass: provider?.constructor.name ?? null,
  }
}

/**
 * 同一个 Consumer handle 先等待，随后跟随两个不同 Provider class 启停。
 */
export async function runServiceReplacementScenario(): Promise<ServiceReplacementResult> {
  const root = new Context()
  const trace: string[] = []
  const activations: string[] = []
  const checkpoints: ServiceCheckpoint[] = []

  try {
    const consumer = root.plugin(createGreeterConsumer(trace, activations))
    await consumer.await()
    checkpoints.push(takeCheckpoint('waiting', root, consumer, trace))

    const friendly = root.plugin(FriendlyGreeterProvider, { trace })
    await friendly.await()
    await consumer.await()
    checkpoints.push(takeCheckpoint('friendly', root, consumer, trace))

    await friendly.dispose()
    await consumer.await()
    checkpoints.push(takeCheckpoint('missing', root, consumer, trace))

    const formal = root.plugin(FormalGreeterProvider, { trace })
    await formal.await()
    await consumer.await()
    checkpoints.push(takeCheckpoint('formal', root, consumer, trace))

    await formal.dispose()
    await consumer.await()
    checkpoints.push(takeCheckpoint('complete', root, consumer, trace))

    await consumer.dispose()
    return { trace: [...trace], activations: [...activations], checkpoints }
  } finally {
    await root.fiber.dispose()
  }
}

/**
 * 故意遗漏 inject 并直接读取 ctx.courseGreeter，捕获 Cordis 的确定性错误。
 */
export async function runMissingInjectScenario(): Promise<MissingInjectResult> {
  const root = new Context()
  const trace: string[] = []
  let applyCount = 0

  try {
    const unsafeConsumer = root.plugin({
      name: 'unsafe-course-greeter-consumer',
      apply(ctx: Context) {
        applyCount += 1
        trace.push('unsafe-consumer:apply')
        ctx.courseGreeter.greet('learner')
      },
    } satisfies Plugin.Object)

    let errorMessage: string | undefined
    try {
      await unsafeConsumer.await()
    } catch (error: unknown) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    if (errorMessage === undefined) {
      throw new Error('negative probe unexpectedly accessed courseGreeter without inject')
    }
    trace.push(`unsafe-consumer:error:${errorMessage}`)

    await unsafeConsumer.dispose()
    return { trace: [...trace], errorMessage, applyCount }
  } finally {
    await root.fiber.dispose()
  }
}
