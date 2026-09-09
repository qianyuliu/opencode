import { expect, test } from "bun:test"
import type { FileNode } from "@opencode-ai/sdk/v2"
import type { SessionArtifact } from "./model"
import { mergeSessionArtifactFiles, scanSessionArtifactFiles, sessionArtifactRoot } from "./artifact-files"

const directory = "/workspace/u-4"
const root = "runs/current"
const node = (path: string, type: FileNode["type"] = "file"): FileNode => ({
  path,
  type,
  name: path.split("/").at(-1)!,
  absolute: `${directory}/${path}`,
  ignored: true,
})

test("the government report's 17 write records and 28 directory files produce 28 files without duplicate metadata", async () => {
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
  const scriptNames = [
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
  const artifacts: SessionArtifact[] = writtenNames.map((filename) => ({
    filename,
    path: `${root}/${filename}`,
    ownerAgentId: "writer",
    ownerSessionId: "child",
    messageId: "message",
    partId: filename,
    role: "supporting",
    createdAt: 100,
    sizeBytes: 99,
  }))
  const scan = await scanSessionArtifactFiles({
    directory,
    root,
    list: async () => [...writtenNames, ...scriptNames].map((name) => node(`${root}/${name}`)),
  })
  const files = mergeSessionArtifactFiles({ artifacts, paths: scan.paths, rootSessionId: "root" })
  expect(files).toHaveLength(28)
  expect(scan.warnings).toEqual([])
  expect(files[0]).toBe(artifacts[0])
  expect(artifacts).toHaveLength(17)
  for (const name of scriptNames) {
    const file = files.find((item) => item.filename === name)!
    expect(file.ownerAgentId).toBe("")
    expect(file.createdAt).toBeUndefined()
    expect(file.sizeBytes).toBeUndefined()
    expect(file.role).toBe("supporting")
  }
})

test("recurses only through current-run directories and includes every extension", async () => {
  const visited: string[] = []
  const scan = await scanSessionArtifactFiles({
    directory,
    root,
    list: async (path) => {
      visited.push(path)
      if (path === root)
        return [
          node(`${root}/binary.dat`),
          node(`${root}/images/`, "directory"),
          node("runs/other/private.md"),
          node("../secret", "directory"),
          node(`${root}/../other`, "directory"),
        ]
      if (path === `${root}/images`) return [node("plot.webp"), node(`${directory}/${root}/images/figure.png`)]
      throw new Error("escaped directory")
    },
  })
  expect(visited).toEqual([root, `${root}/images`])
  expect(scan.paths).toEqual([`${root}/binary.dat`, `${root}/images/figure.png`, `${root}/images/plot.webp`])
  expect(scan.warnings).toHaveLength(1)
})

test("requires explicit per-session metadata and never falls back to the whole workspace", async () => {
  expect(sessionArtifactRoot(directory, { cmccArtifactDirectory: `${directory}/${root}` })).toBe(root)
  for (const value of [undefined, directory, `${directory}/runs`, "/other/runs/job", `${directory}/runs/../other`]) {
    expect(sessionArtifactRoot(directory, { cmccArtifactDirectory: value })).toBeUndefined()
  }
  let requests = 0
  await expect(
    scanSessionArtifactFiles({
      directory,
      root: "",
      list: async () => {
        requests += 1
        return []
      },
    }),
  ).rejects.toThrow()
  expect(requests).toBe(0)
})

test("keeps successfully listed directories when a nested directory fails", async () => {
  const result = await scanSessionArtifactFiles({
    directory,
    root,
    list: async (path) => {
      if (path !== root) throw new Error("denied")
      return [node(`${root}/a.pdf`), node(`${root}/private`, "directory")]
    },
  })
  expect(result.paths).toEqual([`${root}/a.pdf`])
  expect(result.warnings[0]).toContain("private")
})

test("bounds large trees and surfaces truncation instead of claiming completeness", async () => {
  const result = await scanSessionArtifactFiles({
    directory,
    root,
    list: async () => Array.from({ length: 201 }, (_, i) => node(`${root}/${i}.json`)),
  })
  expect(result.paths).toHaveLength(200)
  expect(result.warnings[0]).toContain("上限")
})

test("Linux case-sensitive paths remain separate and original write metadata is untouched", () => {
  const result = mergeSessionArtifactFiles({
    artifacts: [],
    paths: [`${root}/Report.md`, `${root}/report.md`],
    rootSessionId: "root",
  })
  expect(result).toHaveLength(2)
})
