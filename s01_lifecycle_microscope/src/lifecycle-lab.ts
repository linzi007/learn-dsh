import { Context } from '@deepseek-ai/cordis'
import { ResourceLedger } from './resource-ledger.ts'

export interface ScenarioResult {
  trace: string[]
  activeResources: string[]
  childDisposed: boolean
}

export interface LeakScenarioResult extends ScenarioResult {
  detectedError: string
  leaksBeforeEmergencyCleanup: string[]
}

export interface RootCleanupScenarioResult extends ScenarioResult {
  rootReusable: boolean
}

function createManagedResourcePlugin(
  ledger: ResourceLedger,
  trace: string[],
  resourceId: string,
) {
  return function managedResourcePlugin(ctx: Context) {
    trace.push(`plugin:mounted:${resourceId}`)

    ctx.effect(() => {
      const release = ledger.acquire(resourceId)
      return () => {
        release()
        trace.push(`effect:cleaned:${resourceId}`)
      }
    }, `managed resource: ${resourceId}`)
  }
}

interface EmergencyLeakHandle {
  release?: () => void
}

/**
 * 故意错误的插件：资源在 Cordis effect 之外创建，因此 fiber 不拥有它。
 */
function createLeakyResourcePlugin(
  ledger: ResourceLedger,
  trace: string[],
  resourceId: string,
  emergency: EmergencyLeakHandle,
) {
  return function leakyResourcePlugin(_ctx: Context) {
    trace.push(`plugin:mounted:${resourceId}`)
    emergency.release = ledger.acquire(resourceId)
  }
}

export async function runChildDisposalScenario(): Promise<ScenarioResult> {
  const trace: string[] = []
  const ledger = new ResourceLedger(trace)
  const root = new Context()
  const child = root.plugin(createManagedResourcePlugin(ledger, trace, 'heartbeat'))

  await child.await()
  trace.push('host:dispose-child')
  await child.dispose()
  trace.push('host:child-disposed')
  ledger.assertNoLeaks()
  await root.fiber.dispose()

  return {
    trace,
    activeResources: ledger.activeResources(),
    childDisposed: child.uid === null,
  }
}

export async function runRootCleanupScenario(): Promise<RootCleanupScenarioResult> {
  const trace: string[] = []
  const ledger = new ResourceLedger(trace)
  const root = new Context()
  const child = root.plugin(createManagedResourcePlugin(ledger, trace, 'watcher'))

  await child.await()
  trace.push('host:dispose-root-fiber')
  await root.fiber.dispose()
  trace.push('host:root-cleanup-complete')
  ledger.assertNoLeaks()

  let probeMounted = false
  const probe = root.plugin(() => {
    probeMounted = true
  })
  await probe.await()
  await probe.dispose()

  return {
    trace,
    activeResources: ledger.activeResources(),
    childDisposed: child.uid === null,
    rootReusable: probeMounted && probe.uid === null && root.fiber.uid === 0,
  }
}

export async function runLeakDetectionScenario(): Promise<LeakScenarioResult> {
  const trace: string[] = []
  const ledger = new ResourceLedger(trace)
  const emergency: EmergencyLeakHandle = {}
  const root = new Context()
  const child = root.plugin(createLeakyResourcePlugin(
    ledger,
    trace,
    'leaky-connection',
    emergency,
  ))

  await child.await()
  trace.push('host:dispose-child')
  await child.dispose()
  trace.push('host:child-disposed')

  const leaksBeforeEmergencyCleanup = ledger.activeResources()
  let detectedError = ''
  try {
    ledger.assertNoLeaks()
  } catch (error) {
    detectedError = error instanceof Error ? error.message : String(error)
    trace.push(`probe:caught:${detectedError}`)
  }

  // 负例已经留下证据；现在由实验宿主兜底清理，避免测试自身污染后续章节。
  emergency.release?.()
  ledger.assertNoLeaks()
  await root.fiber.dispose()

  return {
    trace,
    activeResources: ledger.activeResources(),
    childDisposed: child.uid === null,
    detectedError,
    leaksBeforeEmergencyCleanup,
  }
}
