#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  process.stderr.write(`PDF export failed: ${message}\n`);
  process.exitCode = 1;
}

function browserCandidates() {
  return [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : null,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : null,
    process.platform === 'linux' ? 'google-chrome' : null,
    process.platform === 'linux' ? 'chromium' : null,
    process.platform === 'linux' ? 'chromium-browser' : null,
  ].filter(Boolean);
}

async function findBrowser() {
  const { access } = await import('node:fs/promises');
  for (const candidate of browserCandidates()) {
    if (!candidate.includes('/') && !candidate.includes('\\')) return candidate;
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('未找到 Chrome、Edge 或 Chromium；可通过 CHROME_PATH 指定浏览器可执行文件');
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForJson(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`浏览器调试端口启动超时：${url}`);
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener('open', resolveOpen, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('无法连接 Chrome DevTools')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolveCommand, rejectCommand } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) rejectCommand(new Error(message.error.message));
      else resolveCommand(message.result || {});
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolveCommand, rejectCommand });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForReport(client, sessionId, timeoutMs = 30000) {
  const started = Date.now();
  let legacyReadyAt = null;
  while (Date.now() - started < timeoutMs) {
    const result = await client.send('Runtime.evaluate', {
      expression: '({complete: document.readyState === "complete", ready: window.__REPORT_READY__, charts: document.querySelectorAll(".chart-canvas svg").length})',
      returnByValue: true,
    }, sessionId);
    const state = result.result?.value || {};
    if (state.complete && state.ready === true) return;
    if (state.complete && typeof state.ready === 'undefined') {
      legacyReadyAt ??= Date.now();
      if (Date.now() - legacyReadyAt >= 2500) return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('HTML 图表和字体在 30 秒内未完成渲染');
}

function headerTemplate(title) {
  const safeTitle = title.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  return `<div style="width:100%;padding:0 20mm;font-family:'Songti SC','SimSun',serif;font-size:8px;color:#777;border-bottom:1px solid #ddd;display:flex;justify-content:space-between;"><span>${safeTitle}</span><span>巡察材料</span></div>`;
}

function footerTemplate() {
  return '<div style="width:100%;padding:0 20mm;font-family:\'Songti SC\',\'SimSun\',serif;font-size:8px;color:#777;display:flex;justify-content:space-between;"><span style="color:#8b1e1e;">内部资料 注意保管</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>';
}

async function main() {
  const inputArg = process.argv[2];
  const outputArg = process.argv[3];
  if (!inputArg) throw new Error('用法：node export-report-pdf.mjs <30-report.html> [35-report.pdf]');

  const input = resolve(inputArg);
  const output = resolve(outputArg || join(dirname(input), '35-report.pdf'));
  const inputStat = await stat(input);
  if (!inputStat.isFile()) throw new Error(`HTML 不存在：${input}`);

  const browser = await findBrowser();
  const profile = await mkdtemp(join(tmpdir(), 'deepinsight-pdf-'));
  const port = await freePort();
  const chrome = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let browserError = '';
  chrome.stderr.on('data', (chunk) => { browserError += chunk.toString(); });
  let client;
  try {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
    client = new CdpClient(version.webSocketDebuggerUrl);
    await client.open();

    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Emulation.setEmulatedMedia', { media: 'print' }, sessionId);
    await client.send('Page.navigate', { url: pathToFileURL(input).href }, sessionId);
    await waitForReport(client, sessionId);

    const fallbackResult = await client.send('Runtime.evaluate', {
      expression: 'Array.from(document.querySelectorAll(".fallback")).filter(function(el){ return el.offsetParent !== null; }).map(function(el){ return el.textContent.trim(); })',
      returnByValue: true,
    }, sessionId);
    const fallbacks = fallbackResult.result?.value || [];
    if (fallbacks.length) throw new Error(`HTML 仍有未渲染内容：${fallbacks.join('；')}`);

    const contaminationResult = await client.send('Runtime.evaluate', {
      expression: String.raw`(function(){
        var text = document.body ? document.body.innerText : '';
        var pattern = /\b(?:COMMON|TYP|CONFLICT|IND)-\d+\b|\bR\d+-I\d+\b|\bSRC-\d+\b|\b(?:group_id|issue_id|conflict_id|source_ids|risk_level|confidence|comments|conflict_type)\b|file:\/\/\/|\/(?:Users|home)\/[^\s]+|\*\*[^*]+\*\*/gi;
        return Array.from(new Set(text.match(pattern) || []));
      })()`,
      returnByValue: true,
    }, sessionId);
    const contamination = contaminationResult.result?.value || [];
    if (contamination.length) {
      throw new Error(`HTML 可见正文仍含内部过程标签，禁止导出 PDF：${contamination.join(', ')}`);
    }

    const chartResult = await client.send('Runtime.evaluate', {
      expression: String.raw`(function(){
        return Array.from(document.querySelectorAll('.chart-canvas')).map(function(el){
          var svg = el.querySelector('svg');
          if (!svg) return { id: el.id, issue: 'missing-svg' };
          var container = el.getBoundingClientRect();
          var textRects = Array.from(svg.querySelectorAll('text')).map(function(node){
            var rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
          }).filter(function(rect){ return rect.width > 0 && rect.height > 0; });
          var overflowing = textRects.some(function(rect){
            return rect.left < container.left - 2 || rect.right > container.right + 2 || rect.top < container.top - 2 || rect.bottom > container.bottom + 2;
          });
          if (overflowing) return { id: el.id, issue: 'label-overflow' };
          for (var i = 0; i < textRects.length; i++) {
            for (var j = i + 1; j < textRects.length; j++) {
              var a = textRects[i], b = textRects[j];
              var overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              var overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (overlapX > 2 && overlapY > 2) return { id: el.id, issue: 'label-overlap' };
            }
          }
          return null;
        }).filter(Boolean);
      })()`,
      returnByValue: true,
    }, sessionId);
    const chartIssues = chartResult.result?.value || [];
    if (chartIssues.length) throw new Error(`图表清晰度/标签边界检查未通过：${JSON.stringify(chartIssues)}`);

    const titleResult = await client.send('Runtime.evaluate', {
      expression: 'document.title || "巡察报告"',
      returnByValue: true,
    }, sessionId);
    const title = titleResult.result?.value || '巡察报告';
    const printResult = await client.send('Page.printToPDF', {
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(title),
      footerTemplate: footerTemplate(),
      printBackground: true,
      preferCSSPageSize: true,
      marginTop: 0.45,
      marginBottom: 0.45,
      marginLeft: 0,
      marginRight: 0,
      transferMode: 'ReturnAsBase64',
    }, sessionId);
    const pdf = Buffer.from(printResult.data, 'base64');
    if (pdf.length < 1024 || pdf.subarray(0, 4).toString() !== '%PDF') {
      throw new Error('浏览器返回的文件不是有效 PDF');
    }
    await writeFile(output, pdf);
    process.stdout.write(`PDF report: ${output} (${pdf.length} bytes)\n`);
  } catch (error) {
    const suffix = browserError.trim() ? `\nChrome: ${browserError.trim().slice(-1200)}` : '';
    throw new Error(`${error.message}${suffix}`);
  } finally {
    if (client) client.close();
    chrome.kill('SIGTERM');
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error.message));
