import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'

const COURSE_FS_TOOLS = new Set(['read', 'write', 'edit'])
const MUTATION_TOOLS = new Set(['write', 'edit'])

export const WORKSPACE_DENIAL_REASON = 'course workspace policy denied a path outside the exact workspace'
export const WORKSPACE_ARGUMENT_DENIAL_REASON = 'course workspace policy requires a string file_path'
export const MUTATION_APPROVAL_REASON = 'workspace 内的文件变更需要本次调用的一次性 Approval'

export interface WorkspacePolicyObservation {
  readonly callId: string
  readonly toolName: string
  readonly requestedPath: string | undefined
  readonly resolvedPath: string | undefined
  readonly insideWorkspace: boolean | undefined
  readonly decision: 'allow-via-next' | 'ask' | 'deny'
}

export interface WorkspacePolicyTrace {
  readonly observations: WorkspacePolicyObservation[]
  readonly dispatchedCallIds: string[]
}

function filePathOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const filePath = (value as Record<string, unknown>)['file_path']
  return typeof filePath === 'string' ? filePath : undefined
}

/**
 * 安装 symlink-aware 的应用层 dispatch policy。
 *
 * `LocalFileSystem.resolve()` 产生 realpath identity，`contains()` 在该身份上
 * 判断边界。这个 listener 只决定 ToolRuntime 是否 dispatch，不是 OS sandbox。
 */
export async function installWorkspaceToolPolicy(
  ctx: Context,
  workspace: string,
  trace: WorkspacePolicyTrace,
): Promise<void> {
  const workspaceTarget = await ctx.fs.resolve(workspace)
  const workspaceInfo = await ctx.fs.stat(workspaceTarget)
  if (workspaceInfo?.type !== 'directory') {
    throw new Error(`S13 workspace is not a directory: ${workspace}`)
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!COURSE_FS_TOOLS.has(exec.name)) return next()

    const requestedPath = filePathOf(exec.arguments)
    if (requestedPath === undefined) {
      trace.observations.push({
        callId: String(exec.callId),
        toolName: exec.name,
        requestedPath,
        resolvedPath: undefined,
        insideWorkspace: undefined,
        decision: 'deny',
      })
      return { kind: 'deny', reason: WORKSPACE_ARGUMENT_DENIAL_REASON }
    }

    const cwd = exec.agent?.session.header.cwd
    if (cwd === undefined) {
      trace.observations.push({
        callId: String(exec.callId),
        toolName: exec.name,
        requestedPath,
        resolvedPath: undefined,
        insideWorkspace: undefined,
        decision: 'deny',
      })
      return { kind: 'deny', reason: 'course workspace policy requires an Agent Session cwd' }
    }

    const target = await ctx.fs.resolve(requestedPath, {
      cwd,
      signal: exec.signal,
    })
    const insideWorkspace = ctx.fs.contains(workspaceTarget, target)
    if (!insideWorkspace) {
      trace.observations.push({
        callId: String(exec.callId),
        toolName: exec.name,
        requestedPath,
        resolvedPath: target.displayPath,
        insideWorkspace,
        decision: 'deny',
      })
      return { kind: 'deny', reason: WORKSPACE_DENIAL_REASON }
    }

    if (MUTATION_TOOLS.has(exec.name)) {
      trace.observations.push({
        callId: String(exec.callId),
        toolName: exec.name,
        requestedPath,
        resolvedPath: target.displayPath,
        insideWorkspace,
        decision: 'ask',
      })
      return { kind: 'ask', reason: MUTATION_APPROVAL_REASON }
    }

    trace.observations.push({
      callId: String(exec.callId),
      toolName: exec.name,
      requestedPath,
      resolvedPath: target.displayPath,
      insideWorkspace,
      decision: 'allow-via-next',
    })
    return next()
  })

  ctx.on('tools/execute', (exec, next) => {
    if (COURSE_FS_TOOLS.has(exec.name)) {
      trace.dispatchedCallIds.push(String(exec.callId))
    }
    return next()
  })
}
