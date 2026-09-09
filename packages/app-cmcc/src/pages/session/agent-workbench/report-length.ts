import { Marked } from "marked"

const markdown = new Marked({ async: false, gfm: true })

export function countReportCharacters(value: string) {
  // Template contents are inert: report scripts and media are never mounted.
  const template = document.createElement("template")
  template.innerHTML = markdown.parse(value, { async: false })
  template.content.querySelectorAll("script, style, template, noscript").forEach((element) => element.remove())
  return Array.from((template.content.textContent ?? "").replace(/\s/gu, "")).length
}
