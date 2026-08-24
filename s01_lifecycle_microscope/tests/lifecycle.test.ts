import { describe, expect, it } from 'vitest'
import {
  runChildDisposalScenario,
  runLeakDetectionScenario,
  runRootCleanupScenario,
} from '../src/lifecycle-lab.ts'

describe('第 1 章：Cordis 生命周期显微镜', () => {
  it('显式 dispose 子 fiber 后释放它拥有的资源', async () => {
    const result = await runChildDisposalScenario()

    expect(result.trace).toEqual([
      'plugin:mounted:heartbeat',
      'resource:acquired:heartbeat',
      'host:dispose-child',
      'resource:released:heartbeat',
      'effect:cleaned:heartbeat',
      'host:child-disposed',
    ])
    expect(result.activeResources).toEqual([])
    expect(result.childDisposed).toBe(true)
  })

  it('调用根 Fiber 的清理入口时递归释放子插件资源', async () => {
    const result = await runRootCleanupScenario()

    expect(result.trace).toEqual([
      'plugin:mounted:watcher',
      'resource:acquired:watcher',
      'host:dispose-root-fiber',
      'resource:released:watcher',
      'effect:cleaned:watcher',
      'host:root-cleanup-complete',
    ])
    expect(result.activeResources).toEqual([])
    expect(result.childDisposed).toBe(true)
    expect(result.rootReusable).toBe(true)
  })

  it('资源未注册为 effect 时，dispose fiber 不能替开发者猜出清理方式', async () => {
    const result = await runLeakDetectionScenario()

    expect(result.childDisposed).toBe(true)
    expect(result.leaksBeforeEmergencyCleanup).toEqual(['leaky-connection'])
    expect(result.detectedError).toBe('resource leak detected: leaky-connection')
    expect(result.activeResources).toEqual([])

    const disposedAt = result.trace.indexOf('host:child-disposed')
    const releasedAt = result.trace.indexOf('resource:released:leaky-connection')
    expect(releasedAt).toBeGreaterThan(disposedAt)
  })
})
