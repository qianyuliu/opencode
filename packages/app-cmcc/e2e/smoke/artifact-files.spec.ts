import { expect, test } from "@playwright/test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2"
import { fixture } from "./session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

test.use({ channel: process.env.PLAYWRIGHT_CHANNEL, video: "off" })

const writtenNames = [
  "01-sensitive.json",
  "04-internal-findings.md",
  "04-internal-findings.meta.json",
  "03-plan.json",
  "05-web-findings-1.md",
  "05-web-findings-1.meta.json",
  "06-intelligence-1.json",
  "07-reflection-1.json",
  "05-web-findings-2.md",
  "05-web-findings-2.meta.json",
  "06-intelligence-2.json",
  "07-reflection-2.json",
  "10-outline.json",
  "20-report.md",
  "21-evidence-review-1.json",
  "21-evidence-review-2.json",
  "25-visual-report.json",
]
const extraNames = [
  "00-input.json",
  "02-brief-data.json",
  "02-source-registry.json",
  "03-internal-materials.md",
  "22-citation-audit.json",
  "22-references.json",
  "23-presentation-audit.json",
  "30-report.html",
  "35-report.pdf",
  "40-stats.json",
  "客户输入.json",
]

for (const agent of [
  {
    type: "zhengqi-visit-intel",
    lead: "zhengqi-visit-intel/zhengqi-visit-intel-team-lead",
    child: "zhengqi-visit-intel/report-chief-writer",
  },
  { type: "deeptrading", lead: "deeptrading/deeptrading-team-lead", child: "deeptrading/dt-intake" },
  { type: "deepinspect", lead: "deepinspect/deepinspect-team-lead", child: "deepinspect/intent-analyst" },
  { type: "shoppers-pro", lead: "shoppers-pro/shoppers-pro-team-lead", child: "shoppers-pro/card-editor" },
]) {
  test(`${agent.type}: lists all 28 files while report selection stays write-based`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const rootId = "ses_files_root"
    const childId = "ses_files_child"
    const run = "runs/files-test"
    const makeSession = (id: string, member: string, parentID?: string): Session => ({
      id,
      slug: id,
      projectID: fixture.project.id,
      directory: fixture.directory,
      title: "文件清单测试",
      agent: member,
      parentID,
      version: "test",
      time: { created: 1000, updated: 3000 },
      metadata: { cmccArtifactDirectory: `${fixture.directory}/${run}` },
    })
    const root = makeSession(rootId, agent.lead)
    const child = makeSession(childId, agent.child, rootId)
    const messages = (id: string): { info: Message; parts: Part[] }[] => {
      const member = id === rootId ? agent.lead : agent.child
      const user: Message = {
        id: `${id}-100`,
        sessionID: id,
        role: "user",
        agent: member,
        time: { created: 1000 },
        model: { providerID: "opencode", modelID: "claude-opus-4-6" },
      }
      const assistant: Message = {
        id: `${id}-200`,
        sessionID: id,
        role: "assistant",
        parentID: user.id,
        agent: member,
        mode: "build",
        modelID: "claude-opus-4-6",
        providerID: "opencode",
        path: { cwd: fixture.directory, root: fixture.directory },
        cost: 0,
        time: { created: 2000, completed: 3000 },
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const parts: Part[] = [
        { id: `${id}-text`, sessionID: id, messageID: assistant.id, type: "text", text: "研究完成" },
      ]
      if (id === childId)
        writtenNames.forEach((name, index) =>
          parts.push({
            id: `${id}-write-${index}`,
            sessionID: id,
            messageID: assistant.id,
            type: "tool",
            tool: "write",
            callID: name,
            state: {
              status: "completed",
              title: name,
              input: { filePath: `${fixture.directory}/${run}/${name}`, content: "report" },
              metadata: {},
              output: "ok",
              time: { start: 2000, end: 2500 + index },
            },
          }),
        )
      return [
        {
          info: user,
          parts: [{ id: `${id}-query`, sessionID: id, messageID: user.id, type: "text", text: "文件清单测试" }],
        },
        { info: assistant, parts },
      ]
    }
    const scans: string[] = []
    const reads: string[] = []
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await mockOpenCodeServer(page, {
      ...fixture,
      sessions: [root, child],
      pageMessages: (id) => ({ items: messages(id) }),
    })
    await page.addInitScript(() => {
      localStorage.setItem("dockapi.accessToken", "artifact-list-test-token")
      localStorage.setItem("opencode.settings.dat:defaultServerUrl", "http://127.0.0.1:4096")
    })
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname
      const json = (data: unknown) =>
        route.fulfill({ json: { code: 200, message: "ok", data }, headers: { "access-control-allow-origin": "*" } })
      if (path === "/api/user/profile")
        return json({
          user: { id: 999, name: "文件测试", enabled: true, casePublishAllowed: false },
          workspace: { id: 999, directoryPath: fixture.directory, status: "READY" },
        })
      if (path === "/api/dockapi/sessions")
        return json([
          {
            id: "business-files",
            agentType: agent.type,
            query: root.title,
            title: root.title,
            openCodeSessionId: rootId,
            directoryPath: fixture.directory,
            openCodeSession: root,
            openCodeStatus: { type: "idle" },
            createdAt: "2026-09-09",
            updatedAt: "2026-09-09",
          },
        ])
      return json([])
    })
    await page.route("**/session/*/children*", (route) =>
      route.fulfill({
        json: new URL(route.request().url()).pathname.includes(rootId) ? [child] : [],
        headers: { "access-control-allow-origin": "*" },
      }),
    )
    await page.route("**/file?*", (route) => {
      const path = new URL(route.request().url()).searchParams.get("path") ?? ""
      scans.push(path)
      return route.fulfill({
        json:
          path === run
            ? [...writtenNames, ...extraNames].map((name) => ({
                name,
                path: `${run}/${name}`,
                absolute: `${fixture.directory}/${run}/${name}`,
                type: "file",
                ignored: true,
              }))
            : [],
        headers: { "access-control-allow-origin": "*" },
      })
    })
    await page.route("**/file/content?*", (route) => {
      const path = new URL(route.request().url()).searchParams.get("path") ?? ""
      reads.push(path)
      const content = path.endsWith("20-report.md")
        ? "# 原有报告\n\n来自工具记录。"
        : path.endsWith(".md")
          ? "# 中间分析\n\n" + "中间内容".repeat(500)
        : path.endsWith("25-visual-report.json")
          ? JSON.stringify({
              layout_version: 2,
              title: "原有报告",
              report: { title: "原有报告", sections: [] },
              sections: [],
            })
          : '{"source":"scanned-file-preview"}'
      return route.fulfill({ json: { type: "text", content }, headers: { "access-control-allow-origin": "*" } })
    })
    await page.route("**/file/download?*", (route) =>
      route.fulfill({
        contentType: "application/pdf",
        body: "%PDF-1.4\nfile-test\n%%EOF",
        headers: { "access-control-allow-origin": "*" },
      }),
    )
    await page.goto(`/server/${Buffer.from("http://127.0.0.1:4096").toString("base64url")}/session/${rootId}`)
    await expect(page.getByRole("button", { name: "文件", exact: true })).toBeVisible()
    if (["zhengqi-visit-intel", "deepinspect"].includes(agent.type)) {
      await expect(page.getByText("报告篇幅", { exact: true }).locator("..").locator("strong")).toHaveText("11字")
      expect(reads.filter((path) => path.endsWith("20-report.md"))).toHaveLength(1)
    }
    await page.getByRole("button", { name: "文件", exact: true }).click()
    await expect(page.getByRole("button", { name: "下载", exact: true })).toHaveCount(28)
    await page.getByRole("button", { name: /00-input.json/ }).click()
    await expect(page.getByText("scanned-file-preview", { exact: false })).toBeVisible()
    await page.getByRole("button", { name: "返回", exact: true }).click()
    const downloading = page.waitForEvent("download")
    await page
      .locator("article")
      .filter({ hasText: "35-report.pdf" })
      .getByRole("button", { name: "下载", exact: true })
      .click()
    expect((await downloading).suggestedFilename()).toBe("35-report.pdf")
    await page.getByRole("button", { name: "文字报告", exact: true }).click()
    if (["zhengqi-visit-intel", "deepinspect"].includes(agent.type)) {
      await page.getByRole("button", { name: "04-internal-findings.md", exact: true }).click()
      await page.getByRole("button", { name: "分析团队", exact: true }).click()
      await expect(page.getByText("报告篇幅", { exact: true }).locator("..").locator("strong")).toHaveText("11字")
    }
    await page.getByRole("button", { name: "可视化报告", exact: true }).click()
    expect(reads.some((path) => path.endsWith("35-report.pdf") || path.endsWith("30-report.html"))).toBe(false)
    expect(scans).toEqual([run])
    await page.getByRole("button", { name: "文件", exact: true }).click()
    await expect(page.getByRole("button", { name: "下载", exact: true })).toHaveCount(28)
    expect(errors).toEqual([])
    if (agent.type === "zhengqi-visit-intel")
      await page.screenshot({ path: info.outputPath("government-28-files.png") })
  })
}
