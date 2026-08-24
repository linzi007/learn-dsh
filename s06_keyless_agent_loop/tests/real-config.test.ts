import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REAL_DEEPSEEK_MODEL,
  REAL_DEEPSEEK_PROVIDER,
  resolveRealDeepSeekConfig,
} from '../src/real-config.ts'

describe('第 6 章：真实 DeepSeek 配置边界（不访问网络）', () => {
  it('缺少或只含空白的 Key 时在请求前失败', () => {
    expect(() => resolveRealDeepSeekConfig({})).toThrow('缺少 DEEPSEEK_API_KEY')
    expect(() => resolveRealDeepSeekConfig({ DEEPSEEK_API_KEY: '   ' }))
      .toThrow('缺少 DEEPSEEK_API_KEY')
  })

  it('不返回 Key，并在未设置课程模型变量时选用固定默认模型', () => {
    const config = resolveRealDeepSeekConfig({ DEEPSEEK_API_KEY: 'course-secret-probe' })

    expect(config).toEqual({
      provider: REAL_DEEPSEEK_PROVIDER,
      model: DEFAULT_REAL_DEEPSEEK_MODEL,
    })
    expect(JSON.stringify(config)).not.toContain('course-secret-probe')
  })

  it('接受显式模型，但拒绝显式空模型', () => {
    expect(resolveRealDeepSeekConfig({
      DEEPSEEK_API_KEY: 'course-secret-probe',
      DEEPSEEK_MODEL: 'private-course-model',
    }).model).toBe('private-course-model')

    expect(() => resolveRealDeepSeekConfig({
      DEEPSEEK_API_KEY: 'course-secret-probe',
      DEEPSEEK_MODEL: '  ',
    })).toThrow('DEEPSEEK_MODEL 不能为空')
  })
})
