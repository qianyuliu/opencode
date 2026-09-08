import { expect, test } from "@playwright/test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import { fixture } from "./session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL, video: "off" })

const agents = [
  {
    type: "ai-for-science-team",
    lead: "ai-for-science-team/ai-for-science-team-team-lead",
    child: "ai-for-science-team/as-evidence-writer",
  },
  { type: "deeptrading", lead: "deeptrading/deeptrading-team-lead", child: "deeptrading/dt-intake" },
  { type: "deepinspect", lead: "deepinspect/deepinspect-team-lead", child: "deepinspect/intent-analyst" },
  {
    type: "zhengqi-visit-intel",
    lead: "zhengqi-visit-intel/zhengqi-visit-intel-team-lead",
    child: "zhengqi-visit-intel/report-chief-writer",
  },
  { type: "shoppers-pro", lead: "shoppers-pro/shoppers-pro-team-lead", child: "shoppers-pro/card-editor" },
]

for (const { agent, live } of [...agents.map((agent) => ({ agent, live: false })), { agent: agents[0], live: true }]) {
  test(`${agent.type}: ${live ? "live completion" : "idle history"} stops counting and reconciles a missing final child update once`, async ({
    page,
  }, info) => {
    const started = Date.now() - 120_000
    const rootId = "ses_runtime_root"
    const childId = "ses_runtime_child"
    const session = (id: string, member: string, parentID?: string): Session => ({
      id,
      slug: id,
      projectID: fixture.project.id,
      directory: fixture.directory,
      title: "计时回归测试",
      agent: member,
      parentID,
      version: "test",
      time: { created: started, updated: started + 60_000 },
      metadata: { cmccArtifactDirectory: `${fixture.directory}/runs/runtime-test` },
    })
    const root = session(rootId, agent.lead)
    const child = session(childId, agent.child, rootId)
    let childReads = 0
    let statusReads = 0
    let busy = live
    const events: unknown[] = []
    const requests: string[] = []
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith("/session/") || path === "/file") requests.push(path)
    })
    const messages = (id: string): { info: Message; parts: Part[] }[] => {
      const isChild = id === childId
      if (isChild) childReads += 1
      const member = isChild ? agent.child : agent.lead
      const user: Message = {
        id: `msg_${id}_100`,
        sessionID: id,
        role: "user",
        agent: member,
        time: { created: started },
        model: { providerID: "opencode", modelID: "claude-opus-4-6" },
      }
      const assistant: Message = {
        id: `msg_${id}_200`,
        sessionID: id,
        role: "assistant",
        parentID: user.id,
        agent: member,
        mode: "build",
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        path: { cwd: fixture.directory, root: fixture.directory },
        time: { created: started + 1000, ...(isChild && childReads === 1 ? {} : { completed: started + 60_000 }) },
        cost: 0,
        tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 0, write: 0 } },
      }
      return [user, assistant].map((message) => ({
        info: message,
        parts: [
          {
            id: `prt_${message.id}`,
            sessionID: id,
            messageID: message.id,
            type: "text",
            text: message.role === "user" ? "计时回归测试" : "研究任务已经完成。",
          },
        ],
      }))
    }
    await mockOpenCodeServer(page, {
      ...fixture,
      sessions: [root, child],
      pageMessages: (id) => ({ items: messages(id) }),
      events: () => events.splice(0),
    })
    await page.addInitScript(() => {
      localStorage.setItem("dockapi.accessToken", "runtime-test-token")
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", "http://127.0.0.1:4096")
    })
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname
      const json = (data: unknown) =>
        route.fulfill({ json: { code: 200, message: "ok", data }, headers: { "access-control-allow-origin": "*" } })
      if (path === "/api/user/profile")
        return json({
          user: { id: 999, name: "计时测试", phone: "", enabled: true, casePublishAllowed: false },
          workspace: { id: 999, workspaceKey: "test", directoryPath: fixture.directory, status: "READY" },
        })
      if (path === "/api/dockapi/sessions")
        return json([
          {
            id: "business-runtime",
            agentType: agent.type,
            query: "计时回归测试",
            title: root.title,
            openCodeSessionId: rootId,
            directoryPath: fixture.directory,
            openCodeSession: root,
            openCodeStatus: { type: "idle" },
            createdAt: new Date(started).toISOString(),
            updatedAt: new Date(started + 60_000).toISOString(),
          },
        ])
      return json([])
    })
    await page.route("**/session/status*", (route) => {
      statusReads += 1
      return route.fulfill({
        json: busy ? { [rootId]: { type: "busy" }, [childId]: { type: "busy" } } : {},
        headers: { "access-control-allow-origin": "*" },
      })
    })
    await page.route("**/session/*/children*", (route) =>
      route.fulfill({
        json: new URL(route.request().url()).pathname.includes(rootId) ? [child] : [],
        headers: { "access-control-allow-origin": "*" },
      }),
    )
    await page.route("**/file?*", (route) =>
      route.fulfill({ json: [], headers: { "access-control-allow-origin": "*" } }),
    )

    const start = performance.now()
    const server = Buffer.from("http://127.0.0.1:4096").toString("base64url")
    await page.goto(`/server/${server}/session/${rootId}`)
    const elapsed = page.getByText("思考时间", { exact: true }).locator("..").locator("strong")
    await expect(elapsed).toBeVisible()
    if (live) {
      await expect(page.locator('[data-slot="session-running-spinner"]')).toHaveCount(1)
      const counting = await elapsed.textContent()
      await expect(elapsed).not.toHaveText(counting!)
      busy = false
      events.push({ type: "session.status", properties: { sessionID: rootId, status: { type: "idle" } } })
    }
    await expect(page.locator('[data-slot="session-running-spinner"]')).toHaveCount(0)
    await expect(elapsed).toHaveText("1分0秒")
    await expect.poll(() => childReads).toBe(2)
    await expect(page.getByRole("button", { name: "看回放", exact: true })).toBeEnabled()
    const loaded = performance.now() - start
    const reads = { status: statusReads, messages: childReads, requests: requests.length }
    await page.waitForTimeout(2200)
    await expect(elapsed).toHaveText("1分0秒")
    expect({ status: statusReads, messages: childReads, requests: requests.length }).toEqual(reads)
    expect(statusReads).toBe(2) // Initial bootstrap plus one final-state reconciliation.
    expect(errors).toEqual([])
    await info.attach("runtime-metrics", {
      body: JSON.stringify({ readyMs: loaded, ...reads }),
      contentType: "application/json",
    })
    if (agent.type === "ai-for-science-team")
      await page.screenshot({ path: info.outputPath("science-stopped-clock.png") })
  })
}
