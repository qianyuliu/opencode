import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { AgentArtifactContent } from "../src/pages/session/agent-workbench/artifact-source"
import type { SessionArtifact } from "../src/pages/session/agent-workbench/model"
import { createReportLength } from "../src/pages/session/agent-workbench/report-length-context"

const report = (createdAt = 1): SessionArtifact => ({
  path: "runs/one/20-report.md",
  filename: "20-report.md",
  createdAt,
  ownerAgentId: "writer",
  ownerSessionId: "child",
  messageId: "m",
  partId: "p",
  role: "text-report",
})
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

function fixture(load?: (force?: boolean) => Promise<string>) {
  return createRoot((dispose) => {
    const [state, setState] = createStore({
      scope: "session-one",
      report: report() as SessionArtifact | undefined,
      file: { loaded: false } as AgentArtifactContent,
      playing: false,
      markdown: "",
      revisionNoise: 0,
      completedRevision: 1,
    })
    const requests: boolean[] = []
    const count = createReportLength({
      scope: () => state.scope,
      report: () => state.report,
      revision: () => state.completedRevision,
      source: {
        get: () => state.file,
        async load(_path, force) {
          if (state.file.loaded && !force) return
          requests.push(!!force)
          const text = await (load?.(force) ?? Promise.resolve("# 最终报告\n\n正文"))
          setState("file", { loaded: true, loading: false, error: undefined, text })
        },
      },
      replaying: () => state.playing,
      replayMarkdown: () => state.markdown,
    })
    return { count, state, setState, requests, dispose }
  })
}

test("loads the final report once and does not refetch on unrelated updates", async () => {
  const f = fixture()
  try {
    expect(f.count()).toBeUndefined()
    await flush()
    expect(f.count()).toBe(6)
    f.setState("revisionNoise", 10)
    await flush()
    expect(f.requests).toEqual([false])
    f.setState("report", report(2))
    await flush()
    expect(f.requests).toEqual([false, true])
  } finally {
    f.dispose()
  }
})

test("completion refreshes reports changed by scripts without a new write record", async () => {
  const f = fixture(async (force) => (force ? "最终报告增加引用" : "初稿"))
  try {
    await flush()
    expect(f.count()).toBe(2)
    f.setState("completedRevision", 2)
    await flush()
    expect(f.count()).toBe(8)
    expect(f.requests).toEqual([false, true])
  } finally {
    f.dispose()
  }
})

test("replay counts only released report text and stopping restores the full length", async () => {
  const f = fixture()
  try {
    await flush()
    f.setState("playing", true)
    expect(f.count()).toBe(0)
    f.setState("markdown", "# 最终报告")
    expect(f.count()).toBe(4)
    f.setState("markdown", "# 最终报告\n\n正文")
    expect(f.count()).toBe(6)
    f.setState("playing", false)
    expect(f.count()).toBe(6)
    expect(f.requests).toHaveLength(1)
  } finally {
    f.dispose()
  }
})

test("missing, ambiguous and non-final reports never fall back to other artifacts", async () => {
  const f = fixture()
  try {
    f.setState("report", undefined)
    await flush()
    expect(f.count()).toBeUndefined()
    expect(f.requests).toHaveLength(0)
    f.setState("report", { ...report(), filename: "10-outline.md", path: "runs/one/10-outline.md" })
    await flush()
    expect(f.count()).toBeUndefined()
    expect(f.requests).toHaveLength(0)
  } finally {
    f.dispose()
  }
})

test("empty reports and reader errors remain unavailable, including during replay", async () => {
  for (const load of [
    async () => "",
    async () => {
      throw new Error("offline")
    },
  ]) {
    const f = fixture(load)
    try {
      await flush()
      expect(f.count()).toBeUndefined()
      f.setState("playing", true)
      expect(f.count()).toBeUndefined()
      expect(f.requests).toHaveLength(1)
    } finally {
      f.dispose()
    }
  }
})

test("late reads after a scope change or unmount cannot restore an old count", async () => {
  let resolve!: (text: string) => void
  const pending = new Promise<string>((yes) => {
    resolve = yes
  })
  const f = fixture(() => pending)
  await flush()
  f.setState("scope", "session-two")
  f.setState("report", undefined)
  resolve("# 旧报告")
  await flush()
  expect(f.count()).toBeUndefined()
  f.dispose()
  const g = fixture()
  g.dispose()
  await flush()
  expect(g.requests).toHaveLength(0)
})
