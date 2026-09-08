const DOC_MIME = "application/msword"
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

export function isWordDocument(file: File, mime: string) {
  const extension = file.name.split(".").at(-1)?.toLowerCase()
  return mime === DOC_MIME || mime === DOCX_MIME || extension === "doc" || extension === "docx"
}

export function isDocx(file: File, mime: string) {
  return mime === DOCX_MIME || file.name.toLowerCase().endsWith(".docx")
}

export function safeUploadedFilename(name: string) {
  return name.replace(/[\\/\u0000-\u001f]/g, "_").trim() || "document"
}

export function fileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => {
      const value = String(reader.result)
      const separator = value.indexOf(",")
      if (separator === -1) return reject(new Error(`无法编码 ${file.name}`))
      resolve(value.slice(separator + 1))
    })
    reader.addEventListener("error", () => reject(reader.error ?? new Error(`无法读取 ${file.name}`)))
    reader.readAsDataURL(file)
  })
}

export async function docxText(file: File) {
  const { default: JSZip } = await import("jszip")
  const archive = await JSZip.loadAsync(await file.arrayBuffer())
  const names = Object.keys(archive.files).filter((name) =>
    /^word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(name),
  )
  const sections = await Promise.all(
    names.map(async (name) => {
      const entry = archive.file(name)
      if (!entry) return ""
      return wordXmlText(await entry.async("text"))
    }),
  )
  return sections.filter(Boolean).join("\n\n").trim()
}

function wordXmlText(xml: string) {
  const document = new DOMParser().parseFromString(xml, "application/xml")
  const paragraphs = Array.from(document.getElementsByTagName("*")).filter((node) => node.localName === "p")
  const blocks = paragraphs.map((paragraph) =>
    Array.from(paragraph.getElementsByTagName("*"))
      .filter((node) => node.localName === "t")
      .map((node) => node.textContent ?? "")
      .join(""),
  )
  return blocks.filter(Boolean).join("\n")
}
