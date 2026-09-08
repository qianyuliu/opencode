import { describe, expect, test } from "bun:test"
import JSZip from "jszip"
import { docxText, safeUploadedFilename } from "./word-documents"

describe("Word document attachments", () => {
  test("extracts paragraph text from DOCX document XML", async () => {
    const archive = new JSZip()
    archive.file(
      "word/document.xml",
      '<?xml version="1.0"?><w:document xmlns:w="word"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>',
    )
    const file = new File([await archive.generateAsync({ type: "blob" })], "report.docx")

    expect(await docxText(file)).toBe("第一段\n第二段")
  })

  test("removes path separators from uploaded filenames", () => {
    expect(safeUploadedFilename("../项目\\报告.docx")).toBe(".._项目_报告.docx")
  })
})
