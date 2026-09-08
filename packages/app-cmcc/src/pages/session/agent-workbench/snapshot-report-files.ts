import type { FileContent } from "@opencode-ai/sdk/v2"
import { untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { artifactPreviewKind } from "../artifact-preview"
import type { AgentArtifactSource } from "./artifact-source"

type ReportFileState = { loaded: boolean; loading: boolean; content?: FileContent; error?: string }

export function createSnapshotReportFiles(source: AgentArtifactSource) {
  const [files, setFiles] = createStore<Record<string, ReportFileState | undefined>>({})
  const pending = new Map<string, Promise<void>>()
  return {
    get: (path: string) => files[path],
    load(path: string): Promise<void> {
      if (untrack(() => files[path]?.loaded)) return Promise.resolve()
      const current = pending.get(path)
      if (current) return current
      setFiles(path, { loaded: false, loading: true, content: undefined, error: undefined })
      const task = readSnapshotReportFile(source, path)
        .then((content) => setFiles(path, { loaded: true, loading: false, content }))
        .catch((error: unknown) => {
          setFiles(path, {
            loaded: false,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => pending.delete(path))
      pending.set(path, task)
      return task
    },
  }
}

async function readSnapshotReportFile(source: AgentArtifactSource, path: string): Promise<FileContent> {
  if (artifactPreviewKind(path) === "markdown") {
    await source.load(path)
    const content = source.get(path)
    if (!content?.loaded || content.error) throw new Error(content?.error ?? "案例报告未返回文件内容")
    return { type: "text", content: content.text ?? "" }
  }
  const blob = await source.download(path)
  return new Promise<FileContent>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("案例报告读取失败"))
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result : ""
      const separator = data.indexOf(",")
      if (separator < 0) {
        reject(new Error("案例报告返回的数据格式不正确"))
        return
      }
      resolve({
        type: "binary",
        content: data.slice(separator + 1),
        encoding: "base64",
        mimeType: blob.type || undefined,
      })
    }
    reader.readAsDataURL(blob)
  })
}
