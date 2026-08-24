import {
  runChildDisposalScenario,
  runLeakDetectionScenario,
  runRootCleanupScenario,
  type ScenarioResult,
} from './lifecycle-lab.ts'

function printScenario(title: string, result: ScenarioResult) {
  console.log(`\n${title}`)
  for (const event of result.trace) console.log(`  ${event}`)
  console.log(`  active resources: ${result.activeResources.length}`)
  console.log(`  child disposed: ${result.childDisposed}`)
}

const child = await runChildDisposalScenario()
printScenario('PASS 1/3：显式 dispose 子 fiber', child)

const root = await runRootCleanupScenario()
printScenario('PASS 2/3：调用根 Fiber 清理整个 composition', root)
console.log(`  root reusable after cleanup: ${root.rootReusable}`)

const leak = await runLeakDetectionScenario()
printScenario('PASS 3/3：负向探针捕获故意泄漏', leak)
console.log(`  detected before emergency cleanup: ${leak.leaksBeforeEmergencyCleanup.join(', ')}`)
