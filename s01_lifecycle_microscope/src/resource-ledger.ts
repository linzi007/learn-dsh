/**
 * 教学用资源账本。
 *
 * 它把 timer、socket、watcher 等不容易稳定观察的外部资源，抽象成可计数、
 * 可断言的资源。它不是 Cordis API，也不是生产资源管理器。
 */
export class ResourceLedger {
  readonly #active = new Set<string>()

  constructor(private readonly trace: string[]) {}

  acquire(resourceId: string): () => void {
    if (this.#active.has(resourceId)) {
      throw new Error(`resource already acquired: ${resourceId}`)
    }

    this.#active.add(resourceId)
    this.trace.push(`resource:acquired:${resourceId}`)

    let released = false
    return () => {
      if (released) return
      released = true
      this.#active.delete(resourceId)
      this.trace.push(`resource:released:${resourceId}`)
    }
  }

  activeResources(): string[] {
    return [...this.#active].sort()
  }

  assertNoLeaks(): void {
    const resources = this.activeResources()
    if (resources.length > 0) {
      throw new Error(`resource leak detected: ${resources.join(', ')}`)
    }
  }
}
