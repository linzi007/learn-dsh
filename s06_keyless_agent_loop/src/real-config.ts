export const REAL_DEEPSEEK_PROVIDER = 'deepseek-official' as const
export const DEFAULT_REAL_DEEPSEEK_MODEL = 'deepseek-v4-flash' as const

export interface RealDeepSeekConfig {
  readonly provider: typeof REAL_DEEPSEEK_PROVIDER
  readonly model: string
}

/**
 * 校验真实实验的进程环境，但绝不返回或打印 API Key。
 * `DEEPSEEK_MODEL` 是 Learn DSH 的课程约定；上游只要求请求显式携带 model。
 */
export function resolveRealDeepSeekConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RealDeepSeekConfig {
  if (!env.DEEPSEEK_API_KEY?.trim()) {
    throw new Error(
      '缺少 DEEPSEEK_API_KEY：先复制 .env.example 为 .env，填写本机 Key 后重试；不要提交 .env。',
    )
  }

  const configuredModel = env.DEEPSEEK_MODEL
  const model = configuredModel === undefined
    ? DEFAULT_REAL_DEEPSEEK_MODEL
    : configuredModel.trim()
  if (!model) {
    throw new Error(
      `DEEPSEEK_MODEL 不能为空；学习默认值是 ${DEFAULT_REAL_DEEPSEEK_MODEL}。`,
    )
  }

  return {
    provider: REAL_DEEPSEEK_PROVIDER,
    model,
  }
}
