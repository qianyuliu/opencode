import { expect, test } from "bun:test"
import { countReportCharacters } from "./report-length"

test("counts visible Markdown text rather than markup, link targets or whitespace", () => {
  const report =
    "# 标题\n\n正文 **粗体** [来源](https://example.test/long-path?q=hidden)\n\n![图片说明](https://example.test/image.png)"
  expect(countReportCharacters(report)).toBe(Array.from("标题正文粗体来源").length)
})

test("includes table cells, lists and visible code without syntax markers", () => {
  const report = "| 指标 | 数值 |\n| --- | --- |\n| A | 12 |\n\n- 条目\n\n`x < y`\n\n```js\nconst x = 1;\n```"
  expect(countReportCharacters(report)).toBe(Array.from("指标数值A12条目x<yconstx=1;").length)
})

test("decodes entities and counts Unicode code points rather than UTF-8 bytes", () => {
  expect(countReportCharacters("中 文 😀 A&nbsp;&amp;&nbsp;B")).toBe(6)
  expect(countReportCharacters("\n\t \u00a0")).toBe(0)
})

test("does not mount or execute embedded report HTML", () => {
  const report =
    '<div>正文 <b>结论</b></div>\n\n<!-- hidden -->\n<script>document.body.dataset.reportExecuted="yes"</script>\n<style>.x {color:red}</style>'
  expect(countReportCharacters(report)).toBe(4)
  expect(document.body.dataset.reportExecuted).toBeUndefined()
})
