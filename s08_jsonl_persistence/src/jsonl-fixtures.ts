import { access, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

const TEMP_BASENAME_PREFIX = 'learn-dsh-s08-'
const TEMP_PATH_PREFIX = join(tmpdir(), TEMP_BASENAME_PREFIX)

export interface UnpackedJsonlArtifact {
  readonly headerRecord: unknown
  readonly eventRecords: readonly unknown[]
}

/** mkdtemp 返回唯一目录；场景只在这个精确路径下制造和修复日志。 */
export function createScenarioRoot(label: string): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(label)) {
    throw new Error(`invalid S08 temp label: ${label}`)
  }
  return mkdtemp(`${TEMP_PATH_PREFIX}${label}-`)
}

/**
 * 删除前再次验证目标确实是本课程在系统临时目录创建的单个目录。
 * 不接受环境变量、glob、tmpdir 本身或仓库路径作为递归删除目标。
 */
export async function removeScenarioRoot(root: string): Promise<void> {
  const target = resolve(root)
  const expectedParent = resolve(tmpdir())
  if (
    dirname(target) !== expectedParent
    || !basename(target).startsWith(TEMP_BASENAME_PREFIX)
  ) {
    throw new Error(`refusing to remove unexpected S08 temp path: ${target}`)
  }
  await rm(target, { recursive: true, force: true })
}

export async function pathIsMissing(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch (error: unknown) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) return true
    throw error
  }
}

/** `packChunks:false` 时，header 后每一行都应是一条原始 SessionEvent。 */
export function parseUnpackedJsonl(content: string): UnpackedJsonlArtifact {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const headerLine = lines.shift()
  if (headerLine === undefined) throw new Error('JSONL artifact has no header line')

  return {
    headerRecord: JSON.parse(headerLine),
    eventRecords: lines.map(line => JSON.parse(line)),
  }
}

/** 从 persistence seam 取得已配置 JSONL 后端的精确工件路径。 */
export function requireArtifactPath(ctx: Context, header: SessionHeader): string {
  const location = ctx.sessionPersistence.locate(header)
  if (location?.kind !== 'jsonl') throw new Error('JSONL artifact location is unavailable')
  return location.path
}

/** 统一 AgentHandle → Context 的逆序清理。 */
export async function disposeRuntime(
  ctx: Context,
  handle?: { dispose(): Promise<void> },
): Promise<void> {
  try {
    if (handle !== undefined) await handle.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
}
