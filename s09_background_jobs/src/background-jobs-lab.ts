import { Context, type Plugin } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { DeterministicJobProducer } from './deterministic-job.ts'
import { createLifecycleOnlyAgent } from './lifecycle-agent.ts'

export const courseJobController = {
  name: 'course-job-controller',
  inject: ['jobs'],
  apply(ctx: Context) {
    ctx.jobs.attachController('s09-course-lab')
  },
} satisfies Plugin.Object

export interface BackgroundJobHarness {
  readonly root: Context
  readonly registryFiber: ReturnType<Context['plugin']>
  readonly controllerFiber?: ReturnType<Context['plugin']>
}

/** 挂载真实 AgentRegistry 与进程内 JobRegistry Provider。 */
export async function createBackgroundJobHarness(
  options: { readonly attachController?: boolean } = {},
): Promise<BackgroundJobHarness> {
  const root = new Context()

  try {
    const agentRegistryFiber = root.plugin(AgentRegistry)
    await agentRegistryFiber.await()
    const registryFiber = root.plugin(LocalJobRegistry)
    await registryFiber.await()

    if (options.attachController === false) return { root, registryFiber }

    const controllerFiber = root.plugin(courseJobController)
    await controllerFiber.await()
    return { root, registryFiber, controllerFiber }
  } catch (error: unknown) {
    await root.fiber.dispose()
    throw error
  }
}

export interface BackgroundJobsScenarioResult {
  readonly explicitJobId: string
  readonly firstReadText: string
  readonly secondReadText: string
  readonly timeoutSnapshot: JobSnapshot
  readonly killResult: 'requested' | 'already-finished'
  readonly stoppingSnapshot: JobSnapshot
  readonly terminalSnapshot: JobSnapshot
  readonly explicitCancellations: readonly (string | undefined)[]
  readonly cleanupJobId: string
  readonly cleanupBeforeDispose: JobSnapshot
  readonly cleanupCancellations: readonly (string | undefined)[]
  readonly jobsAfterOwnerDispose: readonly JobSnapshot[]
}

/**
 * A 展示显式控制；B 展示 owner Fiber 自动清理。两者共用同一真实 registry。
 */
export async function runBackgroundJobsScenario(): Promise<BackgroundJobsScenarioResult> {
  const { root } = await createBackgroundJobHarness()
  const ownerHandle = await createLifecycleOnlyAgent(root, 's09-owner')

  try {
    const explicit = new DeterministicJobProducer({
      label: 'collect deterministic output',
      owner: ownerHandle.agent,
    })
    const explicitJobId = root.jobs.start(explicit.spec)
    explicit.push('alpha\nbeta\n')
    const firstReadText = root.jobs.read(explicitJobId, ownerHandle.agent).text
    const secondReadText = root.jobs.read(explicitJobId, ownerHandle.agent).text
    const timeoutSnapshot = await root.jobs.wait(explicitJobId, 1, ownerHandle.agent)

    const killResult = root.jobs.kill(
      explicitJobId,
      ownerHandle.agent,
      'lesson no longer needs job A',
    )
    const stoppingSnapshot = root.jobs.get(explicitJobId, ownerHandle.agent)
    const terminalSnapshot = await root.jobs.wait(explicitJobId, 1_000, ownerHandle.agent)

    const cleanup = new DeterministicJobProducer({
      label: 'follow owner lifetime',
      owner: ownerHandle.agent,
    })
    const cleanupJobId = root.jobs.start(cleanup.spec)
    const cleanupBeforeDispose = root.jobs.get(cleanupJobId, ownerHandle.agent)

    await ownerHandle.dispose()
    const jobsAfterOwnerDispose = root.jobs.list(ownerHandle.agent)

    return {
      explicitJobId,
      firstReadText,
      secondReadText,
      timeoutSnapshot,
      killResult,
      stoppingSnapshot,
      terminalSnapshot,
      explicitCancellations: explicit.cancellations,
      cleanupJobId,
      cleanupBeforeDispose,
      cleanupCancellations: cleanup.cancellations,
      jobsAfterOwnerDispose,
    }
  } finally {
    await ownerHandle.dispose()
    await root.fiber.dispose()
  }
}
