import { createMemo, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type { DockApiCaseSnapshot } from "@/context/dockapi"
import type { AgentArtifactSource } from "../agent-workbench/artifact-source"
import { createCaseSnapshotReplay } from "../agent-workbench/snapshot-replay"
import { buildCaseSnapshotWorkbench } from "../agent-workbench/snapshot"
import { deepTradingReplayProgressForTimestamp } from "../deeptrading/replay"
import { AI_SCIENCE_MEMBERS } from "./config"
import { aiScienceProgress, buildAiScienceExecutions, isAiScienceVisibleArtifactPath } from "./data"
import { AiScienceWorkbenchValueProvider, type AiScienceWorkbenchContextValue } from "./workbench-context"

const MEMBER_IDS = new Set(AI_SCIENCE_MEMBERS.map((member) => member.id))

export function AiScienceSnapshotWorkbenchProvider(
  props: ParentProps<{
    snapshot: Accessor<DockApiCaseSnapshot>
    artifactSource: AgentArtifactSource
  }>,
) {
  const [state, setState] = createStore({ selectedAgentId: "overview" })
  const snapshotData = createMemo(() =>
    buildCaseSnapshotWorkbench({
      snapshot: props.snapshot(),
      members: AI_SCIENCE_MEMBERS,
      roles: {},
      selectedAgentId: "overview",
      artifacts: (discovery) => ({
        ...discovery,
        artifacts: discovery.artifacts.filter((artifact) => isAiScienceVisibleArtifactPath(artifact.path)),
      }),
    }),
  )
  const actualWorkbench = createMemo(() => snapshotData().workbench)
  const controller = createCaseSnapshotReplay({
    workbench: actualWorkbench,
    selectedAgentId: () => state.selectedAgentId,
    selectOverview: () => setState("selectedAgentId", "overview"),
    artifactSource: props.artifactSource,
  })
  const actualExecutions = createMemo(() => {
    const current = snapshotData()
    if (state.selectedAgentId === "overview") return []
    return buildAiScienceExecutions({
      agentId: state.selectedAgentId,
      children: current.children,
      transcripts: current.transcripts,
      preferredSessionId: current.preferences.get(state.selectedAgentId),
    })
  })
  const executions = createMemo(() => {
    const source = actualExecutions()
    const timeline = controller.timeline()
    if (!controller.replay.isReplaying() || !timeline) return source
    return source.flatMap((execution) => {
      const start = deepTradingReplayProgressForTimestamp(timeline, execution.startedAt)
      if (controller.replay.progress() < start) return []
      const completed = execution.completedAt
        ? deepTradingReplayProgressForTimestamp(timeline, execution.completedAt)
        : undefined
      return [
        {
          ...execution,
          status:
            completed !== undefined && controller.replay.progress() < completed
              ? ("running" as const)
              : execution.status,
        },
      ]
    })
  })
  const progressPercent = createMemo(() =>
    controller.replay.isReplaying()
      ? Math.round(controller.replay.progress() * 100)
      : aiScienceProgress({
          nodes: controller.workbench().agents,
          overviewStatus: controller.workbench().overviewStatus,
        }),
  )

  const value: AiScienceWorkbenchContextValue = {
    workbench: controller.workbench,
    selectedAgentId: () => state.selectedAgentId,
    selectAgent(agentId) {
      if (agentId !== "overview" && !MEMBER_IDS.has(agentId)) return
      setState("selectedAgentId", agentId)
    },
    retrySession: () => Promise.resolve(),
    executions,
    progressPercent,
    artifactRoot: () => undefined,
    filesLoading: () => false,
    artifactSource: props.artifactSource,
    replay: controller.replay,
  }

  return <AiScienceWorkbenchValueProvider value={value}>{props.children}</AiScienceWorkbenchValueProvider>
}
