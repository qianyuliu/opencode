import { expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionTranscript } from "@/pages/session/agent-workbench/model"
import { createWorkbenchRuntime } from "@/pages/session/agent-workbench/runtime"
import { deriveSessionStatus } from "@/pages/session/agent-workbench/session-adapter"
import { calculateElapsedMs } from "@/pages/session/agent-workbench/statistics"

function transcript(id: string): SessionTranscript {
  return {
    session: {
      id,
      slug: id,
      projectID: "test",
      directory: "/workspace",
      title: id,
      version: "test",
      time: { created: 100, updated: 300 },
    },
    status: { type: "idle" },
    messages: [
      {
        id: `${id}-user`,
        sessionID: id,
        role: "user",
        agent: "lead",
        time: { created: 100 },
        model: { providerID: "test", modelID: "test" },
      },
      {
        id: `${id}-assistant`,
        sessionID: id,
        role: "assistant",
        parentID: `${id}-user`,
        agent: "lead",
        mode: "test",
        modelID: "test",
        providerID: "test",
        path: { cwd: "/workspace", root: "/workspace" },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 200, completed: 300 },
      },
    ],
    parts: {},
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

function setup(
  options: {
    rootBusy?: boolean
    childBusy?: boolean
    incomplete?: boolean
    loading?: boolean
    fetch?: () => Promise<Record<string, SessionStatus>>
    reload?: () => Promise<void>
    keepIncomplete?: boolean
  } = {},
) {
  return createRoot((dispose) => {
    const root = transcript("root")
    const child = transcript("child")
    if (options.rootBusy) root.status = { type: "busy" }
    if (options.childBusy) child.status = { type: "busy" }
    if (options.incomplete) delete child.messages[1]!.time.completed
    const [state, setState] = createStore({ active: true, loading: options.loading ?? false, root, children: [child] })
    const calls = { status: 0, reload: [] as string[], applied: [] as string[] }
    const runtime = createWorkbenchRuntime({
      active: () => state.active,
      loading: () => state.loading,
      root: () => state.root,
      children: () => state.children,
      fetchStatuses: () => {
        calls.status += 1
        return options.fetch?.() ?? Promise.resolve({})
      },
      setStatus(id, status) {
        calls.applied.push(id)
        if (id === state.root.session.id) setState("root", "status", status)
        else setState("children", (item) => item.session.id === id, "status", status)
      },
      async reloadSession(id, isCurrent) {
        if (!isCurrent()) return
        calls.reload.push(id)
        await options.reload?.()
        if (!isCurrent()) return
        if (id === "child" && !options.keepIncomplete) setState("children", 0, "messages", 1, "time", "completed", 300)
      },
    })
    const elapsed = (now: number) =>
      calculateElapsedMs({
        root: state.root,
        transcripts: [state.root, ...state.children],
        running: runtime.running(),
        now,
      })
    return { runtime, state, setState, calls, elapsed, dispose }
  })
}

test("idle with an incomplete expert stops the clock and reloads once without inventing completion", async () => {
  const status = deferred<Record<string, SessionStatus>>()
  const f = setup({ incomplete: true, fetch: () => status.promise })
  try {
    expect(f.runtime.running()).toBe(false)
    expect(deriveSessionStatus(f.state.children[0])).toBe("running")
    expect(f.elapsed(1000)).toBe(f.elapsed(9000))
    expect(f.calls.status).toBe(1)
    status.resolve({})
    await flush()
    expect(f.calls.reload).toEqual(["root", "child"])
    expect(deriveSessionStatus(f.state.children[0])).toBe("completed")
    expect(f.runtime.syncing()).toBe(false)
    f.setState("children", 0, "session", "time", "updated", 9000)
    await flush()
    expect(f.calls.status).toBe(1)
    expect(f.elapsed(9999)).toBe(200)
  } finally {
    f.dispose()
  }
})

test("a stopped root reconciles a stale busy child even when its final message is already complete", async () => {
  const f = setup({ rootBusy: true, childBusy: true })
  try {
    expect(f.calls.status).toBe(0)
    expect(f.elapsed(1000)).toBe(900)
    f.setState("root", "status", { type: "idle" })
    await flush()
    expect(f.calls.status).toBe(1)
    expect(f.runtime.running()).toBe(false)
    expect(f.elapsed(9000)).toBe(200)
  } finally {
    f.dispose()
  }
})

test("missing server completion records stay incomplete until a real final update arrives", async () => {
  const f = setup({ incomplete: true, keepIncomplete: true })
  try {
    await flush()
    expect(f.runtime.running()).toBe(false)
    expect(f.runtime.warning()).toContain("缺少完成记录")
    expect(deriveSessionStatus(f.state.children[0])).toBe("running")
    f.setState("children", 0, "messages", 1, "time", "completed", 300)
    expect(f.runtime.warning()).toBeUndefined()
    expect(f.calls.status).toBe(1)
  } finally {
    f.dispose()
  }
})

test("completed history does not add a status or message request", async () => {
  const f = setup()
  try {
    await flush()
    expect(f.calls.status).toBe(0)
    expect(f.calls.reload).toEqual([])
    expect(f.elapsed(9000)).toBe(200)
  } finally {
    f.dispose()
  }
})

test("waits for initial message loading before reconciling an already idle page", async () => {
  const f = setup({ loading: true, incomplete: true })
  try {
    expect(f.calls.status).toBe(0)
    f.setState("loading", false)
    await flush()
    expect(f.calls.status).toBe(1)
  } finally {
    f.dispose()
  }
})

test("confirmed busy and retry children keep counting even when the root is idle", async () => {
  const f = setup({ childBusy: true, fetch: async () => ({ child: { type: "busy" } }) })
  try {
    await flush()
    expect(f.runtime.running()).toBe(true)
    f.setState("children", 0, "status", { type: "retry", attempt: 1, message: "retry", next: 9000 })
    expect(f.elapsed(1000)).toBe(900)
    f.setState("children", 0, "status", { type: "idle" })
    expect(f.runtime.running()).toBe(false)
    expect(f.calls.status).toBe(1)
  } finally {
    f.dispose()
  }
})

test("a newer SSE child status is not overwritten by an older HTTP response", async () => {
  const status = deferred<Record<string, SessionStatus>>()
  const f = setup({ incomplete: true, fetch: () => status.promise })
  try {
    f.setState("children", 0, "status", { type: "busy" })
    status.resolve({})
    await flush()
    expect(f.state.children[0]!.status?.type).toBe("busy")
    expect(f.runtime.running()).toBe(true)
  } finally {
    f.dispose()
  }
})

for (const change of ["session", "directory", "inactive", "followup", "unmount"] as const) {
  test(`ignores a late status response after ${change}`, async () => {
    const status = deferred<Record<string, SessionStatus>>()
    const f = setup({ incomplete: true, fetch: () => status.promise })
    try {
      if (change === "session" || change === "directory") f.setState("loading", true)
      if (change === "session") f.setState("root", transcript("other"))
      if (change === "directory") f.setState("root", "session", "directory", "/other")
      if (change === "inactive") f.setState("active", false)
      if (change === "followup") f.setState("root", "status", { type: "busy" })
      if (change === "unmount") f.dispose()
      status.resolve({})
      await flush()
      expect(f.calls.applied).toEqual([])
      expect(f.calls.reload).toEqual([])
    } finally {
      f.dispose()
    }
  })
}

test("restarts for a follow-up turn and settles that turn only once", async () => {
  const f = setup({ incomplete: true })
  try {
    await flush()
    expect(f.calls.status).toBe(1)
    f.setState("root", "status", { type: "busy" })
    expect(f.runtime.running()).toBe(true)
    f.setState("root", "status", { type: "idle" })
    await flush()
    expect(f.calls.status).toBe(2)
    expect(f.runtime.running()).toBe(false)
  } finally {
    f.dispose()
  }
})

test("failures are visible and do not create a status polling loop", async () => {
  const f = setup({
    incomplete: true,
    fetch: async () => {
      throw new Error("offline")
    },
  })
  try {
    await flush()
    expect(f.runtime.warning()).toContain("offline")
    expect(f.runtime.syncing()).toBe(false)
    expect(f.runtime.running()).toBe(false)
    expect(f.calls.status).toBe(1)
    expect(f.calls.reload).toEqual([])
  } finally {
    f.dispose()
  }
})

test("an in-flight final message refresh cannot write into a following turn", async () => {
  const reload = deferred<void>()
  const f = setup({ incomplete: true, reload: () => reload.promise })
  try {
    await flush()
    f.setState("root", "status", { type: "busy" })
    reload.resolve()
    await flush()
    expect(f.state.children[0]!.messages[1]!.time.completed).toBeUndefined()
    expect(f.runtime.running()).toBe(true)
  } finally {
    f.dispose()
  }
})
