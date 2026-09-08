import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { AgentArtifactSource } from "./artifact-source"
import type { AgentWorkbench } from "./model"
import type { SearchUrlEvent } from "./statistics"
import {
  DEEPTRADING_REPLAY_DURATION_MS,
  advanceDeepTradingReplay,
  compileDeepTradingReplay,
  createDeepTradingReplayFrame,
  deepTradingReplayStage,
  replayNestedAgentSessions,
  type DeepTradingReplayFrame,
  type DeepTradingReplayStage,
  type DeepTradingReplayTimeline,
} from "../deeptrading/replay"

export function createCaseSnapshotReplay(input: {
  workbench: Accessor<AgentWorkbench>
  selectedAgentId: Accessor<string>
  selectOverview: () => void
  artifactSource: AgentArtifactSource
  searchUrlEvents?: Accessor<readonly SearchUrlEvent[]>
}) {
  const [state, setState] = createStore({
    preparing: false,
    playing: false,
    progress: 0,
    stage: "idle" as DeepTradingReplayStage,
    frame: undefined as DeepTradingReplayFrame | undefined,
  })
  let runId = 0
  let timer: number | undefined
  let startedAt = 0
  let timeline: DeepTradingReplayTimeline | undefined
  let nextCueIndex = 0

  const clearTimer = () => {
    if (timer === undefined) return
    window.clearInterval(timer)
    timer = undefined
  }
  const stop = (completed = false) => {
    runId += 1
    clearTimer()
    timeline = undefined
    nextCueIndex = 0
    setState({
      preparing: false,
      playing: false,
      progress: completed ? 1 : 0,
      stage: "idle",
      frame: undefined,
    })
  }
  const canReplay = createMemo(() => {
    const source = input.workbench()
    if (
      source.loading ||
      source.error ||
      source.overviewStatus !== "completed" ||
      source.agents.some((agent) => agent.status === "running")
    )
      return false
    return !!(
      source.overviewMarkdown.trim() ||
      source.agents.some((agent) => agent.markdown.trim() || agent.sessionId) ||
      source.artifacts.length
    )
  })
  const update = (progress: number) => {
    if (!timeline || !state.frame) return
    const advanced = advanceDeepTradingReplay({ timeline, frame: state.frame, nextCueIndex, progress })
    nextCueIndex = advanced.nextCueIndex
    setState({
      preparing: false,
      playing: true,
      progress: advanced.frame.progress,
      stage: deepTradingReplayStage(timeline, advanced.frame.progress),
      frame: advanced.frame,
    })
  }
  const start = async () => {
    if (state.preparing || state.playing || !canReplay()) return false
    const currentRun = ++runId
    const source = input.workbench()
    const rootSessionId = source.rootSessionId
    setState("preparing", true)
    try {
      if (source.textReportPath) {
        await input.artifactSource.load(source.textReportPath)
        const report = input.artifactSource.get(source.textReportPath)
        if (report?.error) throw new Error(report.error)
      }
    } catch (error) {
      if (currentRun === runId) stop()
      throw error
    }
    if (currentRun !== runId) return false
    if (input.workbench().rootSessionId !== rootSessionId || !canReplay()) {
      setState("preparing", false)
      return false
    }
    timeline = compileDeepTradingReplay({
      workbench: source,
      searchUrlEvents: input.searchUrlEvents?.() ?? [],
      textReportMarkdown: source.textReportPath ? (input.artifactSource.get(source.textReportPath)?.text ?? "") : "",
    })
    nextCueIndex = 0
    startedAt = performance.now()
    input.selectOverview()
    setState({
      preparing: false,
      playing: true,
      progress: 0,
      stage: "team",
      frame: createDeepTradingReplayFrame(timeline),
    })
    update(0.001)
    timer = window.setInterval(() => {
      if (currentRun !== runId) {
        clearTimer()
        return
      }
      const progress = Math.min(1, (performance.now() - startedAt) / DEEPTRADING_REPLAY_DURATION_MS)
      update(progress)
      if (progress >= 1) stop(true)
    }, 500)
    return true
  }
  const displayed = createMemo<AgentWorkbench>(() => {
    const source = input.workbench()
    if (!state.playing || !timeline || !state.frame) return source
    if (input.selectedAgentId() === "overview") return state.frame.workbench
    const selected = state.frame.workbench.agents.find((agent) => agent.id === input.selectedAgentId())
    if (!selected || selected.status === "waiting") return state.frame.workbench
    return {
      ...state.frame.workbench,
      nestedAgentSessions: replayNestedAgentSessions(timeline, source.nestedAgentSessions, state.progress),
      nestedAgentSessionsLoading: false,
      nestedAgentSessionsError: source.nestedAgentSessionsError,
    }
  })

  createEffect(
    on(
      createMemo(() => input.workbench().rootSessionId),
      () => stop(),
      { defer: true },
    ),
  )

  onCleanup(() => {
    runId += 1
    clearTimer()
  })

  return {
    workbench: displayed,
    timeline: () => timeline,
    replay: {
      canReplay,
      isPreparing: () => state.preparing,
      isReplaying: () => state.playing,
      progress: () => state.progress,
      stage: () => state.stage,
      textReportMarkdown: () => state.frame?.textReportMarkdown ?? "",
      start,
      stop: () => stop(),
    },
  }
}
