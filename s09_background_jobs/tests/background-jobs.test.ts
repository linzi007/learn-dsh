import { describe, expect, it } from 'vitest'
import { JobId } from '@deepseek-ai/dsh-jobs'
import {
  courseJobController,
  createBackgroundJobHarness,
  runBackgroundJobsScenario,
} from '../src/background-jobs-lab.ts'
import { DeterministicJobProducer } from '../src/deterministic-job.ts'
import { createLifecycleOnlyAgent } from '../src/lifecycle-agent.ts'

describe('第 9 章：Background jobs', () => {
  it('串联消费式 read、wait timeout、显式 kill 与 owner cleanup', async () => {
    const result = await runBackgroundJobsScenario()

    expect(result).toMatchObject({
      explicitJobId: 'course-1',
      firstReadText: 'alpha\nbeta\n',
      secondReadText: '',
      timeoutSnapshot: { status: 'running', reported: false },
      killResult: 'requested',
      stoppingSnapshot: { status: 'stopping', reported: true },
      terminalSnapshot: { status: 'killed', reported: true },
      explicitCancellations: ['lesson no longer needs job A'],
      cleanupJobId: 'course-2',
      cleanupBeforeDispose: { status: 'running' },
      cleanupCancellations: ['owner disposed'],
      jobsAfterOwnerDispose: [],
    })
  })

  it('没有 controller 时在 run 与 id 分配前拒绝 start', async () => {
    const { root } = await createBackgroundJobHarness({ attachController: false })

    try {
      const rejected = new DeterministicJobProducer({ label: 'must not start' })
      expect(() => root.jobs.start(rejected.spec)).toThrow('no job controller serves this agent')
      expect(rejected.started).toBe(false)
      expect(root.jobs.list()).toEqual([])

      const controllerFiber = root.plugin(courseJobController)
      await controllerFiber.await()
      const accepted = new DeterministicJobProducer({ label: 'first committed job' })
      expect(root.jobs.start(accepted.spec)).toBe('course-1')
      accepted.complete()
      await accepted.completion
    } finally {
      await root.fiber.dispose()
    }
  })

  it('list/read/kill/wait 都执行 owner session isolation', async () => {
    const { root } = await createBackgroundJobHarness()
    const alice = await createLifecycleOnlyAgent(root, 'alice')
    const bob = await createLifecycleOnlyAgent(root, 'bob')

    try {
      const producer = new DeterministicJobProducer({
        label: 'alice private label',
        owner: alice.agent,
      })
      const id = root.jobs.start(producer.spec)

      expect(root.jobs.list(alice.agent).map(job => job.id)).toEqual([id])
      expect(root.jobs.list(bob.agent)).toEqual([])
      expect(() => root.jobs.get(id, bob.agent)).toThrow(`job ${id} belongs to another session`)
      expect(() => root.jobs.read(id, bob.agent)).toThrow(`job ${id} belongs to another session`)
      expect(() => root.jobs.kill(id, bob.agent)).toThrow('belongs to another session')
      await expect(root.jobs.wait(id, 10, bob.agent)).rejects.toThrow('belongs to another session')
      expect(root.jobs.get(id, alice.agent).status).toBe('running')
      expect(producer.cancellations).toEqual([])
    } finally {
      await alice.dispose()
      await bob.dispose()
      await root.fiber.dispose()
    }
  })

  it('owner dispose 只清理 exact owner，不影响 sibling owner 与 unowned job', async () => {
    const { root } = await createBackgroundJobHarness()
    const alice = await createLifecycleOnlyAgent(root, 'cleanup-alice')
    const bob = await createLifecycleOnlyAgent(root, 'cleanup-bob')

    try {
      const aliceProducer = new DeterministicJobProducer({
        label: 'alice-owned',
        owner: alice.agent,
      })
      const bobProducer = new DeterministicJobProducer({
        label: 'bob-owned',
        owner: bob.agent,
      })
      const unownedProducer = new DeterministicJobProducer({ label: 'unowned' })
      const aliceId = root.jobs.start(aliceProducer.spec)
      const bobId = root.jobs.start(bobProducer.spec)
      const unownedId = root.jobs.start(unownedProducer.spec)

      await alice.dispose()

      expect(aliceProducer.cancellations).toEqual(['owner disposed'])
      expect(root.jobs.list(alice.agent).map(job => job.id)).toEqual([unownedId])
      expect(root.jobs.get(bobId, bob.agent)).toMatchObject({ status: 'running' })
      expect(root.jobs.get(unownedId)).toMatchObject({ status: 'running' })
      expect(root.jobs.list(bob.agent).map(job => job.id)).toEqual([bobId, unownedId])
      expect(() => root.jobs.get(aliceId, alice.agent)).toThrow(`unknown job ${aliceId}`)

      bobProducer.complete('bob finished independently')
      unownedProducer.complete('unowned finished independently')
      await expect(root.jobs.wait(bobId, 1_000, bob.agent)).resolves.toMatchObject({
        status: 'completed',
      })
      await expect(root.jobs.wait(unownedId, 1_000)).resolves.toMatchObject({
        status: 'completed',
      })
    } finally {
      await alice.dispose()
      await bob.dispose()
      await root.fiber.dispose()
    }
  })

  it('AbortSignal 只取消 wait，job 与 producer 继续运行', async () => {
    const { root } = await createBackgroundJobHarness()

    try {
      const producer = new DeterministicJobProducer({ label: 'abort only the waiter' })
      const id = root.jobs.start(producer.spec)
      const controller = new AbortController()
      const waiting = root.jobs.wait(id, 1_000, undefined, controller.signal)
      controller.abort()

      await expect(waiting).rejects.toThrow('wait aborted')
      expect(root.jobs.get(id)).toMatchObject({ status: 'running', reported: false })
      expect(producer.cancellations).toEqual([])

      producer.complete('finished after waiter left')
      await expect(root.jobs.wait(id, 1_000)).resolves.toMatchObject({ status: 'completed' })
    } finally {
      await root.fiber.dispose()
    }
  })

  it('throwing cancel 会传播错误，并保持 running 与 reported=false', async () => {
    const { root } = await createBackgroundJobHarness()

    try {
      const producer = new DeterministicJobProducer({
        label: 'broken cancellation contract',
        cancelError: 'cancel boom',
      })
      const id = root.jobs.start(producer.spec)

      expect(() => root.jobs.kill(id, undefined, 'stop')).toThrow('cancel boom')
      expect(root.jobs.get(id)).toMatchObject({ status: 'running', reported: false })
      expect(producer.cancellations).toEqual([])

      producer.complete('test-owned recovery')
      await expect(root.jobs.wait(id, 1_000)).resolves.toMatchObject({ status: 'completed' })
    } finally {
      await root.fiber.dispose()
    }
  })

  it('JobRegistry service dispose 会取消并等待 unowned job', async () => {
    const { root, registryFiber } = await createBackgroundJobHarness()
    const producer = new DeterministicJobProducer({ label: 'service-owned work' })
    const id = root.jobs.start(producer.spec)

    try {
      expect(id).toBe(JobId('course-1'))
      await registryFiber.dispose()

      await expect(producer.completion).resolves.toEqual({
        status: 'killed',
        detail: 'jobs service disposed',
      })
      expect(producer.cancellations).toEqual(['jobs service disposed'])
      expect(root.get('jobs')).toBeUndefined()
    } finally {
      await root.fiber.dispose()
    }
  })
})
