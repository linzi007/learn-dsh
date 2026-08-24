import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import {
  COURSE_WRITE_TOOL_NAME,
  type CourseWriteTarget,
} from './course-write-tool.ts'

export const PUBLISH_APPROVAL_REASON = 'publish 会影响对外内容，需要一次性 Approval'
export const SYSTEM_DENIAL_REASON = 'course policy 禁止写入 system 区域'

export interface PermissionPolicyObservation {
  readonly callId: string
  readonly target: CourseWriteTarget | 'invalid'
  readonly decision: 'allow-via-next' | 'ask' | 'deny'
}

function targetOf(value: unknown): CourseWriteTarget | 'invalid' {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const target = (value as Record<string, unknown>)['target']
  if (target === 'draft' || target === 'publish' || target === 'system') return target
  return 'invalid'
}

/**
 * 安装本章的 tools/pre-execute policy。
 *
 * draft 是安全路径，但这里仍必须调用 next()，让后续组合的 policy 有机会
 * 收紧决定；直接返回 allow 会抢占 waterfall，错误地绕过后续监听器。
 */
export function installCourseWritePermissionPolicy(
  ctx: Context,
  observations: PermissionPolicyObservation[] = [],
): () => void {
  return ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (exec.name !== COURSE_WRITE_TOOL_NAME) return next()

    const target = targetOf(exec.arguments)
    switch (target) {
      case 'draft':
        observations.push({
          callId: String(exec.callId),
          target,
          decision: 'allow-via-next',
        })
        return next()
      case 'publish':
        observations.push({
          callId: String(exec.callId),
          target,
          decision: 'ask',
        })
        return { kind: 'ask', reason: PUBLISH_APPROVAL_REASON }
      case 'system':
        observations.push({
          callId: String(exec.callId),
          target,
          decision: 'deny',
        })
        return { kind: 'deny', reason: SYSTEM_DENIAL_REASON }
      default:
        observations.push({
          callId: String(exec.callId),
          target: 'invalid',
          decision: 'deny',
        })
        return { kind: 'deny', reason: 'course_write target 未通过 policy 分类' }
    }
  })
}
