import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const TEMP_BASENAME_PREFIX = 'learn-dsh-s13-'
const TEMP_PATH_PREFIX = join(tmpdir(), TEMP_BASENAME_PREFIX)
const OUTSIDE_PRIVATE_FIXTURE = 'outside-private-fixture-f4c89d\n'

export const COURSE_FILE_NAME = 'lesson.md'
export const ESCAPE_LINK_NAME = 'escape-link.txt'
export const INITIAL_COURSE_CONTENT = '# S13 课程文件\n\n状态：初始\n'
export const CONTEXT_A_COURSE_CONTENT = '# S13 课程文件\n\n状态：Context A 已读后编辑\n'
export const FINAL_COURSE_CONTENT = '# S13 课程文件\n\n状态：Context B 恢复后编辑\n'

export interface CapstoneFixture {
  readonly root: string
  readonly workspace: string
  readonly persistenceRoot: string
  readonly courseFile: string
  readonly outsideFile: string
  readonly escapeLink: string
}

/**
 * 构造课程专用临时根。Node fixture 负责准备输入；Agent 只会拿到 workspace cwd。
 */
export async function createCapstoneFixture(): Promise<CapstoneFixture> {
  const root = await mkdtemp(`${TEMP_PATH_PREFIX}run-`)
  const workspace = join(root, 'workspace')
  const persistenceRoot = join(root, 'sessions')
  const courseFile = join(workspace, COURSE_FILE_NAME)
  const outsideFile = join(root, 'outside.txt')
  const escapeLink = join(workspace, ESCAPE_LINK_NAME)

  try {
    await mkdir(workspace)
    await mkdir(persistenceRoot)
    await writeFile(courseFile, INITIAL_COURSE_CONTENT, 'utf8')
    await writeFile(outsideFile, OUTSIDE_PRIVATE_FIXTURE, 'utf8')
    await symlink('../outside.txt', escapeLink)

    return {
      root,
      workspace,
      persistenceRoot,
      courseFile,
      outsideFile,
      escapeLink,
    }
  } catch (error: unknown) {
    await removeCapstoneFixture(root)
    throw error
  }
}

/** 只删除 mkdtemp 返回的、位于系统临时目录下一层的精确 S13 根。 */
export async function removeCapstoneFixture(root: string): Promise<void> {
  const target = resolve(root)
  if (
    dirname(target) !== resolve(tmpdir())
    || !basename(target).startsWith(TEMP_BASENAME_PREFIX)
  ) {
    throw new Error(`refusing to remove unexpected S13 temp path: ${target}`)
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

export function readCourseFile(fixture: CapstoneFixture): Promise<string> {
  return readFile(fixture.courseFile, 'utf8')
}

export async function outsideFixtureIsUnchanged(
  fixture: CapstoneFixture,
): Promise<boolean> {
  return await readFile(fixture.outsideFile, 'utf8') === OUTSIDE_PRIVATE_FIXTURE
}

/** 检查 Agent transcript 是否意外包含了只存在于 outside fixture 的内容。 */
export function transcriptLeaksOutsideFixture(transcript: unknown): boolean {
  return JSON.stringify(transcript).includes(OUTSIDE_PRIVATE_FIXTURE.trim())
}
