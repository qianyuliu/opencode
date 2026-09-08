import { createEffect, createMemo, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type { DockApiCaseSnapshot } from "@/context/dockapi"
import type { AgentArtifactSource } from "../agent-workbench/artifact-source"
import { createCaseSnapshotReplay } from "../agent-workbench/snapshot-replay"
import { buildCaseSnapshotWorkbench, findCaseSnapshotArtifact } from "../agent-workbench/snapshot"
import { deepTradingReplayProgressForTimestamp } from "../deeptrading/replay"
import {
  DEEPINSPECT_ARTIFACT_ROLES,
  DEEPINSPECT_CORE_MEMBER_IDS,
  DEEPINSPECT_MEMBERS,
  DEEPINSPECT_OPTIONAL_MEMBER_IDS,
} from "./config"
import { buildDeepInspectExecutions, deepInspectProgress, parseDeepInspectIssueCount } from "./data"
import { DeepInspectWorkbenchValueProvider, type DeepInspectWorkbenchContextValue } from "./workbench-context"

const MEMBER_IDS = new Set(DEEPINSPECT_MEMBERS.map((member) => member.id))

export function DeepInspectSnapshotWorkbenchProvider(
  props: ParentProps<{
    snapshot: Accessor<DockApiCaseSnapshot>
    artifactSource: AgentArtifactSource
  }>,
) {
  const [state, setState] = createStore({ selectedAgentId: "overview" })
  const snapshotData = createMemo(() =>
    buildCaseSnapshotWorkbench({
      snapshot: props.snapshot(),
      members: DEEPINSPECT_MEMBERS,
      roles: DEEPINSPECT_ARTIFACT_ROLES,
      selectedAgentId: "overview",
    }),
  )
  const actualWorkbench = createMemo(() => snapshotData().workbench)
  const controller = createCaseSnapshotReplay({
    workbench: actualWorkbench,
    selectedAgentId: () => state.selectedAgentId,
    selectOverview: () => setState("selectedAgentId", "overview"),
    artifactSource: props.artifactSource,
  })
  const issueArtifact = createMemo(() => {
    const directory = snapshotData().discovery.runDirectory
    return directory === undefined
      ? undefined
      : findCaseSnapshotArtifact(actualWorkbench().artifacts, "06-consolidated-issues.json", directory)
  })

  createEffect(() => {
    const artifact = issueArtifact()
    if (artifact) void props.artifactSource.load(artifact.path)
  })

  const actualIssueCount = createMemo(() => {
    const artifact = issueArtifact()
    const text = artifact ? props.artifactSource.get(artifact.path)?.text : undefined
    return text === undefined ? undefined : parseDeepInspectIssueCount(text)
  })
  const actualExecutions = createMemo(() => {
    const current = snapshotData()
    if (state.selectedAgentId === "overview") return []
    return buildDeepInspectExecutions({
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
  const issueCount = createMemo(() => {
    const value = actualIssueCount()
    if (!controller.replay.isReplaying()) return value
    const path = issueArtifact()?.path
    return path && controller.workbench().artifacts.some((artifact) => artifact.path === path)
      ? value
      : value === undefined
        ? undefined
        : 0
  })
  const progressPercent = createMemo(() =>
    deepInspectProgress({
      nodes: controller.workbench().agents,
      coreAgentIds: DEEPINSPECT_CORE_MEMBER_IDS,
      optionalAgentIds: DEEPINSPECT_OPTIONAL_MEMBER_IDS,
    }),
  )

  const value: DeepInspectWorkbenchContextValue = {
    workbench: controller.workbench,
    selectedAgentId: () => state.selectedAgentId,
    selectAgent(agentId) {
      if (agentId !== "overview" && !MEMBER_IDS.has(agentId)) return
      setState("selectedAgentId", agentId)
    },
    retrySession: () => Promise.resolve(),
    executions,
    progressPercent,
    issueCount,
    artifactSource: props.artifactSource,
    replay: controller.replay,
  }

  return <DeepInspectWorkbenchValueProvider value={value}>{props.children}</DeepInspectWorkbenchValueProvider>
}
