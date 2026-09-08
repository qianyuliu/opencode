import { expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { AgentWorkbench } from "@/pages/session/agent-workbench/model"
import { createCaseSnapshotReplay } from "@/pages/session/agent-workbench/snapshot-replay"

test("changing the selected expert does not cancel replay but changing the root session does", async () => {
  const fixture = createRoot((dispose) => {
    const [state, setState] = createStore({ root: "root-one", selected: "expert" })
    const workbench = createMemo<AgentWorkbench>(() => ({
      rootSessionId: state.root,
      query: "query",
      overviewMarkdown: "completed overview",
      overviewTurns: [],
      overviewStatus: "completed",
      agents: [
        {
          id: "expert",
          name: "Expert",
          profession: "Analyst",
          sessionId: "child",
          status: "completed",
          markdown: "completed analysis",
          startedAt: 10,
          completedAt: 100,
        },
      ],
      nestedAgentSessions:
        state.selected === "overview"
          ? []
          : [{ id: "nested", parentSessionId: "child", title: "Nested", status: "completed" }],
      nestedAgentSessionsLoading: false,
      stats: { elapsedMs: 100, tokenCount: 10, uniqueSearchUrlCount: 0, expertCount: 1 },
      artifacts: [],
      ambiguities: [],
      loading: false,
    }))
    const controller = createCaseSnapshotReplay({
      workbench,
      selectedAgentId: () => state.selected,
      selectOverview: () => setState("selected", "overview"),
      artifactSource: {
        get: () => undefined,
        load: async () => {},
        download: async () => new Blob(),
        previewUrl: () => undefined,
      },
    })
    return { controller, setState, dispose }
  })
  try {
    expect(await fixture.controller.replay.start()).toBe(true)
    expect(fixture.controller.replay.isReplaying()).toBe(true)
    fixture.setState("selected", "expert")
    expect(fixture.controller.replay.isReplaying()).toBe(true)
    fixture.setState("root", "root-two")
    expect(fixture.controller.replay.isReplaying()).toBe(false)
    expect(fixture.controller.workbench().rootSessionId).toBe("root-two")
  } finally {
    fixture.dispose()
  }
})
