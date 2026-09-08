import type { SessionStatus } from "@opencode-ai/sdk/v2"
import { batch, createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionTranscript } from "./model"
import { deriveSessionStatus } from "./session-adapter"

export function createWorkbenchRuntime(input: {
  active: Accessor<boolean>
  loading: Accessor<boolean>
  root: Accessor<SessionTranscript | undefined>
  children: Accessor<readonly SessionTranscript[]>
  fetchStatuses: () => Promise<Record<string, SessionStatus>>
  setStatus: (sessionId: string, status: SessionStatus) => void
  reloadSession: (sessionId: string, isCurrent: () => boolean) => Promise<void>
}) {
  const [state, setState] = createStore({ syncing: false, warning: undefined as string | undefined })
  const transcripts = createMemo(() => {
    const root = input.active() ? input.root() : undefined
    return root ? [root, ...input.children()] : []
  })
  const key = createMemo(() => {
    const root = transcripts()[0]
    if (!root) return undefined
    const query = root.messages.findLast((message) => message.role === "user")
    return JSON.stringify([root.session.directory, root.session.id, query?.id])
  })
  const rootBusy = createMemo(() => isBusy(transcripts()[0]?.status))
  // Presentation status may be incomplete or stale; it must not keep the clock alive.
  const running = createMemo(() => transcripts().some((item) => isBusy(item.status)))
  const incomplete = createMemo(() => transcripts().some((item) => deriveSessionStatus(item) === "running"))
  let generation = 0
  let currentKey: string | undefined
  let checked = false
  let wasRunning = false

  const settle = async (current: number) => {
    const isCurrent = () => current === generation
    const sessions = transcripts().map((item) => ({ id: item.session.id, status: JSON.stringify(item.status) }))
    try {
      const statuses = await input.fetchStatuses()
      if (!isCurrent()) return
      batch(() => {
        for (const session of sessions) {
          const latest = transcripts().find((item) => item.session.id === session.id)
          // A newer SSE status wins over this HTTP response.
          if (!latest || JSON.stringify(latest.status) !== session.status) continue
          input.setStatus(session.id, statuses[session.id] ?? { type: "idle" })
        }
      })
      if (!isCurrent()) return
      const results = await Promise.allSettled(sessions.map((session) => input.reloadSession(session.id, isCurrent)))
      if (!isCurrent()) return
      const failure = results.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
      if (!running() && incomplete()) setState("warning", "部分会话缺少完成记录，计时已停止，未将专家标记为已完成")
    } catch (error) {
      if (isCurrent()) {
        setState("warning", `任务结束状态核对失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (isCurrent()) setState("syncing", false)
    }
  }

  createEffect(
    on(
      () => ({ key: key(), busy: rootBusy(), loading: input.loading(), incomplete: incomplete() }),
      (next) => {
        if (next.key !== currentKey) {
          generation += 1
          currentKey = next.key
          checked = false
          wasRunning = false
          setState({ syncing: false, warning: undefined })
        }
        if (!next.key) return
        if (next.busy) {
          generation += 1
          checked = false
          wasRunning = true
          setState({ syncing: false, warning: undefined })
          return
        }
        if (!next.incomplete && !next.loading) setState("warning", undefined)
        if (next.loading || checked || (!wasRunning && !next.incomplete)) return
        // One reconciliation per stopped turn, including an already-idle page with stale child data.
        checked = true
        setState({ syncing: true, warning: undefined })
        void settle(++generation)
      },
    ),
  )

  onCleanup(() => {
    generation += 1
  })

  return {
    running,
    syncing: () => state.syncing,
    warning: () => state.warning,
  }
}

function isBusy(status?: SessionStatus) {
  return status?.type === "busy" || status?.type === "retry"
}
