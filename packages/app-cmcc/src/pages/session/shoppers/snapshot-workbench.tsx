import { createEffect, createMemo, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type { DockApiCaseSnapshot } from "@/context/dockapi"
import type { AgentArtifactSource } from "../agent-workbench/artifact-source"
import { createCaseSnapshotReplay } from "../agent-workbench/snapshot-replay"
import { buildCaseSnapshotWorkbench, caseSnapshotNestedSessions } from "../agent-workbench/snapshot"
import { collectSearchUrlEvents } from "../agent-workbench/statistics"
import { SHOPPERS_ARTIFACT_ROLES, SHOPPERS_CARD_EDITOR_AGENT, SHOPPERS_MEMBERS } from "./config"
import { cardEditorJsonArtifacts, parseShoppersRecommendation, recommendationFromCardEditorTasks } from "./data"
import { ShoppersWorkbenchValueProvider, type ShoppersWorkbenchContextValue } from "./workbench-context"

const MEMBER_IDS = new Set(SHOPPERS_MEMBERS.map((member) => member.id))

export function ShoppersSnapshotWorkbenchProvider(
  props: ParentProps<{
    snapshot: Accessor<DockApiCaseSnapshot>
    artifactSource: AgentArtifactSource
  }>,
) {
  const [state, setState] = createStore({ selectedAgentId: "overview" })
  const snapshotData = createMemo(() =>
    buildCaseSnapshotWorkbench({
      snapshot: props.snapshot(),
      members: SHOPPERS_MEMBERS,
      roles: SHOPPERS_ARTIFACT_ROLES,
      selectedAgentId: "overview",
    }),
  )
  const childTranscripts = createMemo(() => {
    const current = snapshotData()
    return current.children.flatMap((session) => {
      const transcript = current.transcripts.get(session.id)
      return transcript ? [transcript] : []
    })
  })
  const searchUrlEvents = createMemo(() => collectSearchUrlEvents(childTranscripts()))
  const actualWorkbench = createMemo(() => {
    const source = snapshotData().workbench
    return {
      ...source,
      nestedAgentSessions: caseSnapshotNestedSessions(snapshotData(), state.selectedAgentId),
      stats: {
        ...source.stats,
        uniqueSearchUrlCount: new Set(searchUrlEvents().flatMap((event) => event.urls)).size,
      },
    }
  })
  const recommendationArtifacts = createMemo(() =>
    cardEditorJsonArtifacts(actualWorkbench().artifacts, SHOPPERS_CARD_EDITOR_AGENT),
  )

  createEffect(() => {
    recommendationArtifacts().forEach((artifact) => void props.artifactSource.load(artifact.path))
  })

  const controller = createCaseSnapshotReplay({
    workbench: actualWorkbench,
    selectedAgentId: () => state.selectedAgentId,
    selectOverview: () => setState("selectedAgentId", "overview"),
    artifactSource: props.artifactSource,
    searchUrlEvents,
  })
  const recommendationCount = createMemo(() => {
    const root = snapshotData().root
    const taskCount = root
      ? recommendationFromCardEditorTasks(root, SHOPPERS_CARD_EDITOR_AGENT)?.productCount
      : undefined
    let fileCount: number | undefined
    for (const artifact of recommendationArtifacts()) {
      const text = props.artifactSource.get(artifact.path)?.text
      if (!text) continue
      const parsed = parseShoppersRecommendation(text)
      if (parsed) {
        fileCount = parsed.productCount
        break
      }
    }
    const value = taskCount ?? fileCount
    if (!controller.replay.isReplaying()) return value
    const editor = controller.workbench().agents.find((agent) => agent.id === SHOPPERS_CARD_EDITOR_AGENT)
    return editor?.status === "completed" ? value : undefined
  })

  const value: ShoppersWorkbenchContextValue = {
    workbench: controller.workbench,
    recommendationCount,
    selectedAgentId: () => state.selectedAgentId,
    selectAgent(agentId) {
      if (agentId !== "overview" && !MEMBER_IDS.has(agentId)) return
      setState("selectedAgentId", agentId)
    },
    retrySession: () => Promise.resolve(),
    artifactSource: props.artifactSource,
    replay: controller.replay,
  }

  return <ShoppersWorkbenchValueProvider value={value}>{props.children}</ShoppersWorkbenchValueProvider>
}
