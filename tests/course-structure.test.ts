import { access, readFile, readdir } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

const chapterDirectories = [
  's01_lifecycle_microscope',
  's02_service_seam',
  's03_append_only_session',
  's04_projection_replay',
  's05_tool_contract',
  's06_keyless_agent_loop',
  's07_permission',
  's08_jsonl_persistence',
  's09_background_jobs',
  's10_compaction',
  's11_mcp_bridge',
  's12_subagent_workflow',
  's13_capstone',
]

const requiredFiles = [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'UPSTREAM.md',
  'THIRD_PARTY_NOTICES.md',
  ...chapterDirectories.flatMap(directory => [
    `${directory}/README.md`,
    `${directory}/src/demo.ts`,
  ]),
  's01_lifecycle_microscope/tests/chapter-contract.test.ts',
  's01_lifecycle_microscope/tests/lifecycle.test.ts',
  's02_service_seam/tests/chapter-contract.test.ts',
  's02_service_seam/tests/service.test.ts',
  's03_append_only_session/tests/chapter-contract.test.ts',
  's03_append_only_session/tests/session.test.ts',
  's04_projection_replay/tests/chapter-contract.test.ts',
  's04_projection_replay/tests/projection-replay.test.ts',
  's05_tool_contract/tests/chapter-contract.test.ts',
  's05_tool_contract/tests/tool-contract.test.ts',
  's06_keyless_agent_loop/tests/chapter-contract.test.ts',
  's06_keyless_agent_loop/tests/agent-loop.test.ts',
  's07_permission/tests/chapter-contract.test.ts',
  's07_permission/tests/permission.test.ts',
  's08_jsonl_persistence/tests/chapter-contract.test.ts',
  's08_jsonl_persistence/tests/persistence.test.ts',
  's09_background_jobs/tests/chapter-contract.test.ts',
  's09_background_jobs/tests/background-jobs.test.ts',
  's10_compaction/tests/chapter-contract.test.ts',
  's10_compaction/tests/compaction.test.ts',
  's11_mcp_bridge/tests/chapter-contract.test.ts',
  's11_mcp_bridge/tests/mcp-bridge.test.ts',
  's12_subagent_workflow/tests/chapter-contract.test.ts',
  's12_subagent_workflow/tests/subagent-workflow.test.ts',
  's13_capstone/tests/chapter-contract.test.ts',
  's13_capstone/tests/capstone.test.ts',
]

const markdownFiles = [
  'README.md',
  'CONTRIBUTING.md',
  'UPSTREAM.md',
  'THIRD_PARTY_NOTICES.md',
  ...chapterDirectories.map(directory => `${directory}/README.md`),
  'validation/README.md',
]

async function typescriptFiles(directory: string): Promise<string[]> {
  const absoluteDirectory = resolve(repositoryRoot, directory)
  const entries = await readdir(absoluteDirectory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const relativePath = `${directory}/${entry.name}`
    if (entry.isDirectory()) return typescriptFiles(relativePath)
    return entry.isFile() && entry.name.endsWith('.ts') ? [relativePath] : []
  }))
  return nested.flat()
}

function importedPackages(source: string, filename: string): string[] {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const specifiers: string[] = []

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function directPackageName(specifier: string): string | undefined {
  if (
    specifier.startsWith('.')
    || specifier.startsWith('/')
    || specifier.startsWith('#')
    || isBuiltin(specifier)
  ) return undefined

  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/', 1)[0]
}

describe('课程仓库结构', () => {
  it('保留已发布版本必需的开源与教学文件', async () => {
    await Promise.all(requiredFiles.map(file => access(resolve(repositoryRoot, file))))
  })

  it('Markdown 中的本地链接都能解析', async () => {
    const missingLinks: string[] = []

    for (const file of markdownFiles) {
      const absoluteFile = resolve(repositoryRoot, file)
      const markdown = await readFile(absoluteFile, 'utf8')
      const links = markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)

      for (const match of links) {
        const target = match[1]?.trim()
        if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue

        const pathWithoutAnchor = decodeURIComponent(target.split('#', 1)[0] ?? '')
        if (!pathWithoutAnchor) continue

        try {
          await access(resolve(dirname(absoluteFile), pathWithoutAnchor))
        } catch {
          missingLinks.push(`${file} → ${target}`)
        }
      }
    }

    expect(missingLinks).toEqual([])
  })

  it('上游源码链接固定到课程基线，而不是浮动分支', async () => {
    const upstream = await readFile(resolve(repositoryRoot, 'UPSTREAM.md'), 'utf8')

    expect(upstream).toContain('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
    expect(upstream).not.toMatch(/github\.com\/deepseek-ai\/deepseek-harness\/blob\/(?:master|main)\//)
  })

  it('章节源码只从根 package.json 声明的直接依赖导入第三方包', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const declared = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ])
    const files = (await Promise.all(chapterDirectories.flatMap(directory => [
      typescriptFiles(`${directory}/src`),
      typescriptFiles(`${directory}/tests`),
    ]))).flat()
    const undeclared: string[] = []

    for (const file of files) {
      const source = await readFile(resolve(repositoryRoot, file), 'utf8')
      for (const specifier of importedPackages(source, file)) {
        const packageName = directPackageName(specifier)
        if (packageName === undefined) continue
        if (!declared.has(packageName)) undeclared.push(`${file} → ${packageName}`)
      }
    }

    expect(undeclared).toEqual([])
  })

  it('所有生产直接依赖都出现在第三方声明中', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    const notices = await readFile(resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')

    for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
      const expected = name.startsWith('@deepseek-ai/dsh-') ? `${name}@${version}` : name
      expect(notices, `第三方声明缺少 ${name}`).toContain(expected)
    }
  })
})
