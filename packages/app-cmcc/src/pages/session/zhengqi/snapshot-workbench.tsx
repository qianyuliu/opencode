import { createMemo, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import type { DockApiCaseSnapshot } from "@/context/dockapi"
import type { AgentArtifactSource } from "../agent-workbench/artifact-source"
import { createCaseSnapshotReplay } from "../agent-workbench/snapshot-replay"
import { buildCaseSnapshotWorkbench, caseSnapshotNestedSessions } from "../agent-workbench/snapshot"
import { collectSearchUrlEvents } from "../agent-workbench/statistics"
import { ZHENGQI_ARTIFACT_ROLES, ZHENGQI_MEMBERS, ZHENGQI_PUBLIC_RESEARCH_AGENT } from "./config"
import { zhengqiPublicResearchTranscripts } from "./data"
import { ZhengqiWorkbenchValueProvider, type ZhengqiWorkbenchContextValue } from "./workbench-context"

const MEMBER_IDS = new Set(ZHENGQI_MEMBERS.map((member) => member.id))

export function ZhengqiSnapshotWorkbenchProvider(
  props: ParentProps<{
    snapshot: Accessor<DockApiCaseSnapshot>
    artifactSource: AgentArtifactSource
  }>,
) {
  const [state, setState] = createStore({ selectedAgentId: "overview" })
  const snapshotData = createMemo(() =>
    buildCaseSnapshotWorkbench({
      snapshot: props.snapshot(),
      members: ZHENGQI_MEMBERS,
      roles: ZHENGQI_ARTIFACT_ROLES,
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
  const searchUrlEvents = createMemo(() =>
    collectSearchUrlEvents(zhengqiPublicResearchTranscripts(childTranscripts(), ZHENGQI_PUBLIC_RESEARCH_AGENT)),
  )
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
  const controller = createCaseSnapshotReplay({
    workbench: actualWorkbench,
    selectedAgentId: () => state.selectedAgentId,
    selectOverview: () => setState("selectedAgentId", "overview"),
    artifactSource: props.artifactSource,
    searchUrlEvents,
  })

  const value: ZhengqiWorkbenchContextValue = {
    workbench: controller.workbench,
    selectedAgentId: () => state.selectedAgentId,
    selectAgent(agentId) {
      if (agentId !== "overview" && !MEMBER_IDS.has(agentId)) return
      setState("selectedAgentId", agentId)
    },
    retrySession: () => Promise.resolve(),
    artifactSource: props.artifactSource,
    replay: controller.replay,
  }

  return <ZhengqiWorkbenchValueProvider value={value}>{props.children}</ZhengqiWorkbenchValueProvider>
}
