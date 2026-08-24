import { describe, expect, it } from 'vitest'
import {
  runMissingInjectScenario,
  runServiceReplacementScenario,
} from '../src/service-lab.ts'

describe('第 2 章：Service seam', () => {
  it('Consumer 先挂载时不运行，也没有生命周期 Effect', async () => {
    const result = await runServiceReplacementScenario()
    const waiting = result.checkpoints[0]

    expect(waiting).toEqual({
      step: 'waiting',
      trace: [],
      effects: [],
      providerClass: null,
    })
  })

  it('两个不同 Provider class 复用同一个 Consumer', async () => {
    const result = await runServiceReplacementScenario()

    expect(result.activations).toEqual([
      '你好，learner！',
      'Welcome, learner.',
    ])
    expect(result.checkpoints.map(checkpoint => checkpoint.providerClass)).toEqual([
      null,
      'FriendlyGreeterProvider',
      null,
      'FormalGreeterProvider',
      null,
    ])
  })

  it('Provider 消失时清理 Consumer Effect，替代实现出现时重新登记', async () => {
    const result = await runServiceReplacementScenario()

    expect(result.checkpoints.map(checkpoint => checkpoint.effects)).toEqual([
      [],
      ['course-greeter-consumer-lifetime'],
      [],
      ['course-greeter-consumer-lifetime'],
      [],
    ])
    expect(result.trace).toEqual([
      'provider:constructed:friendly',
      'consumer:start:你好，learner！',
      'consumer:stop:你好，learner！',
      'provider:constructed:formal',
      'consumer:start:Welcome, learner.',
      'consumer:stop:Welcome, learner.',
    ])
  })

  it('缺少 inject 时直接读取 Context 属性会失败', async () => {
    const result = await runMissingInjectScenario()

    expect(result.applyCount).toBe(1)
    expect(result.errorMessage).toMatch(/cannot get property "courseGreeter" without inject/)
    expect(result.trace).toEqual([
      'unsafe-consumer:apply',
      `unsafe-consumer:error:${result.errorMessage}`,
    ])
  })
})
