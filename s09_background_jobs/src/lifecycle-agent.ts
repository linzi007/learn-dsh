import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

export interface LifecycleOnlyAgentHandle {
  readonly agent: Agent
  dispose(): Promise<void>
}

/**
 * 只为 S09 提供 owner identity 与 Fiber 生命周期的 Agent fixture。
 *
 * Session、Inbox、AgentRegistry registration 和 owner Fiber 都是真实公开 API；
 * send/followup/steer/inject 不驱动模型，因此它不是 AgentLoop 的替代实现。
 */
export async function createLifecycleOnlyAgent(
  root: Context,
  rawId: string,
): Promise<LifecycleOnlyAgentHandle> {
  const ownerFiber = root.plugin(() => {})
  await ownerFiber.await()

  const id = SessionId(rawId)
  const session = Session.create(id)
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, {
      inserted() {},
      discarded() {},
      claimed() {},
    }),
    status: 'idle',
    ctx: ownerFiber.ctx,
    cancel() {},
    whenIdle() { return Promise.resolve() },
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return task(new AbortController().signal)
    },
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  const unregister = root.agents.register(agent)
  let disposed = false

  return {
    agent,
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        // jobs.ownerCleanup() 属于这个 Fiber；对守约 producer 会 cancel、await done、再删记录。
        await ownerFiber.dispose()
      } finally {
        unregister()
      }
    },
  }
}
