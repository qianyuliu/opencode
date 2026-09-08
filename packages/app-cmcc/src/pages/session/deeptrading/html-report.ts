export type DeepTradingHtmlReportPreviewInput = {
  serverUrl: string | URL
  directory: string
  path: string
  runtimeUrl: string
  pageOrigin: string
  authToken?: string
}

export function deepTradingHtmlReportPreviewUrl(input: DeepTradingHtmlReportPreviewInput) {
  return artifactHtmlPreviewUrl(input)
}
import { artifactHtmlPreviewUrl } from "../artifact-html-preview"
