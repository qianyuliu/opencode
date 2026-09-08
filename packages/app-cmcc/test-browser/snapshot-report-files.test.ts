import { expect, test } from "bun:test"
import { artifactBytes } from "@/pages/session/artifact-preview"
import type { AgentArtifactSource } from "@/pages/session/agent-workbench/artifact-source"
import { createSnapshotReportFiles } from "@/pages/session/agent-workbench/snapshot-report-files"

test("snapshot markdown uses the case text cache and preserves UTF-8 content", async () => {
  let loads = 0
  const source: AgentArtifactSource = {
    get: () => ({ loaded: true, text: "# 科研报告\n案例正文" }),
    load: async () => {
      loads += 1
    },
    download: async () => {
      throw new Error("Markdown should use the case text source")
    },
    previewUrl: (path) => `/api/dockapi/case-preview/test/artifacts/${path}`,
  }
  const files = createSnapshotReportFiles(source)
  await files.load("paper.md")
  await files.load("paper.md")
  expect(files.get("paper.md")?.content).toEqual({ type: "text", content: "# 科研报告\n案例正文" })
  expect(loads).toBe(1)
})

test("snapshot Office and PDF files preserve every binary byte", async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
  const source: AgentArtifactSource = {
    get: () => undefined,
    load: async () => {
      throw new Error("Binary reports must not use the text loader")
    },
    download: async () => new Blob([bytes], { type: "application/octet-stream" }),
    previewUrl: () => undefined,
  }
  const files = createSnapshotReportFiles(source)
  for (const path of ["paper.docx", "paper.pdf"]) {
    await files.load(path)
    const content = files.get(path)?.content
    expect(content?.encoding).toBe("base64")
    expect(new Uint8Array(artifactBytes(content?.content ?? ""))).toEqual(bytes)
  }
})

test("concurrent report readers await the same request and errors allow an explicit retry", async () => {
  let loads = 0
  let finish: (() => void) | undefined
  let failed = true
  const source: AgentArtifactSource = {
    get: () => (failed ? { loaded: false, error: "HTTP 404" } : { loaded: true, text: "report" }),
    load: () => {
      loads += 1
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    },
    download: async () => new Blob(),
    previewUrl: () => undefined,
  }
  const files = createSnapshotReportFiles(source)
  const first = files.load("paper.md")
  const second = files.load("paper.md")
  expect(first).toBe(second)
  expect(files.get("paper.md")?.loading).toBe(true)
  finish?.()
  await first
  expect(files.get("paper.md")?.error).toBe("HTTP 404")
  expect(loads).toBe(1)
  failed = false
  const retry = files.load("paper.md")
  finish?.()
  await retry
  expect(files.get("paper.md")?.loaded).toBe(true)
  expect(files.get("paper.md")?.error).toBeUndefined()
  expect(loads).toBe(2)
})
