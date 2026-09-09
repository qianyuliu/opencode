#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const input = resolve(process.argv[2] || "");
const output = resolve(process.argv[3] || join(dirname(input), "45-report.pdf"));
if (!process.argv[2]) throw new Error("用法：node export-report-pdf.mjs <40-report.html> [45-report.pdf]");
if (!(await stat(input)).isFile()) throw new Error(`HTML 不存在：${input}`);

const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : null,
  process.platform === "linux" ? "google-chrome" : null,
  process.platform === "linux" ? "chromium" : null
].filter(Boolean);

let browser;
for (const candidate of candidates) {
  if (!candidate.includes("/") && !candidate.includes("\\")) { browser = candidate; break; }
  if (await access(candidate).then(() => true, () => false)) { browser = candidate; break; }
}
if (!browser) throw new Error("未找到 Chrome、Edge 或 Chromium；可通过 CHROME_PATH 指定");

const freePort = () => new Promise((done, reject) => {
  const server = createServer();
  server.unref();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => done(address.port));
  });
});

const waitForJson = async (url, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`浏览器调试端口启动超时：${url}`);
};

class CdpClient {
  constructor(url) { this.id = 1; this.pending = new Map(); this.socket = new WebSocket(url); }
  async open() {
    await new Promise((done, reject) => {
      this.socket.addEventListener("open", done, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("无法连接浏览器调试端口")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.done(message.result || {});
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.id++;
    return new Promise((done, reject) => {
      this.pending.set(id, { done, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.socket.close(); }
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const profile = await mkdtemp(join(tmpdir(), "deeptrading-pdf-"));
const port = await freePort();
const chrome = spawn(browser, [
  "--headless=new", "--disable-gpu", "--disable-extensions", "--allow-file-access-from-files",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
let browserError = "";
chrome.stderr.on("data", (chunk) => { browserError += chunk.toString(); });
let client;

try {
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
  client = new CdpClient(version.webSocketDebuggerUrl);
  await client.open();
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Emulation.setEmulatedMedia", { media: "print" }, sessionId);
  await client.send("Page.navigate", { url: pathToFileURL(input).href }, sessionId);

  const started = Date.now();
  while (Date.now() - started < 30000) {
    const result = await client.send("Runtime.evaluate", {
      expression: '({complete:document.readyState==="complete",charts:Array.from(document.querySelectorAll("[id^=chart-]")).filter(function(el){return el.offsetParent!==null}).length})',
      returnByValue: true
    }, sessionId);
    const state = result.result?.value || {};
    if (state.complete) break;
    await new Promise((done) => setTimeout(done, 250));
  }

  const titleResult = await client.send("Runtime.evaluate", { expression: 'document.title || "深度研究报告"', returnByValue: true }, sessionId);
  const title = escapeHtml(titleResult.result?.value || "深度研究报告");
  const headerTemplate = `<div style="width:100%;padding:0 18mm;font-family:'PingFang SC','Microsoft YaHei',sans-serif;font-size:8px;color:#64748b;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between"><span>${title}</span><span>DeepTrading</span></div>`;
  const footerTemplate = '<div style="width:100%;padding:0 18mm;font-family:\'PingFang SC\',\'Microsoft YaHei\',sans-serif;font-size:8px;color:#94a3b8;display:flex;justify-content:space-between"><span>内部研究资料</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>';
  const result = await client.send("Page.printToPDF", {
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
    printBackground: true,
    preferCSSPageSize: true,
    marginTop: 0.42,
    marginBottom: 0.42,
    marginLeft: 0,
    marginRight: 0,
    transferMode: "ReturnAsBase64"
  }, sessionId);
  const pdf = Buffer.from(result.data, "base64");
  if (pdf.length < 1024 || pdf.subarray(0, 4).toString() !== "%PDF") throw new Error("浏览器返回的文件不是有效 PDF");
  await writeFile(output, pdf);
  process.stdout.write(`已生成 PDF：${output}（${pdf.length} 字节）\n`);
} catch (error) {
  const suffix = browserError.trim() ? `\n浏览器：${browserError.trim().slice(-1200)}` : "";
  throw new Error(`${error.message}${suffix}`);
} finally {
  client?.close();
  chrome.kill("SIGTERM");
  if (chrome.exitCode === null) {
    await Promise.race([
      new Promise((done) => chrome.once("exit", done)),
      new Promise((done) => setTimeout(done, 2000))
    ]);
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
      break;
    } catch (error) {
      if (attempt === 3) process.stderr.write(`临时浏览器目录稍后由系统清理：${error.message}\n`);
      else await new Promise((done) => setTimeout(done, 250));
    }
  }
}
