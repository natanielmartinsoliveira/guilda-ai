/**
 * The evidence kit, uploaded to the task folder in the workspace and required by the agent's
 * Playwright script. It is ours, not the agent's: it takes the print, masks credentials and
 * draws the frame with the page's real URL and the capture time, so every print carries what
 * the audit asks for. Plain CommonJS for the official Playwright image (no build step there).
 */
export const KIT_JS = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const out = () => process.env.EVIDENCE_OUT || '/evidence/out';
const SECRET = /^(authorization|cookie|set-cookie|x-csrf-token)$|token|secret|key|pass/i;
function maskHeaders(h) {
  return Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k, SECRET.test(k) ? '•••' : v]));
}
/** The company's time zone (formats.evidence.timezone), passed by run.sh; UTC otherwise. */
const zone = () => process.env.EVIDENCE_TZ || 'UTC';
function stamp(d) {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: zone(), day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return get('day') + '/' + get('month') + '/' + get('year') + ' ' + get('hour') + ':' +
    get('minute') + ':' + get('second') + ' (' + zone() + ')';
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function frameHtml({ url, at, image }) {
  return '<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px system-ui,sans-serif;background:#dfe3e8">' +
    '<div style="display:flex;gap:10px;align-items:center;padding:8px 12px;background:#f1f3f4;border-bottom:1px solid #c8ccd0">' +
    '<span style="color:#5f6368">&#8592; &#8594; &#8635;</span>' +
    '<div style="flex:1;background:#fff;border-radius:16px;padding:6px 14px;color:#202124">' + esc(url) + '</div></div>' +
    '<img src="' + image + '" style="display:block;width:100%">' +
    '<div style="padding:6px 12px;background:#202124;color:#fff;text-align:right">' + esc(at) + '</div></body>';
}
const manifestFile = () => path.join(out(), 'manifest.json');
function manifest() {
  return fs.existsSync(manifestFile()) ? JSON.parse(fs.readFileSync(manifestFile(), 'utf8')) : { shots: [] };
}
function slug(t) {
  return String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'print';
}
async function framed(page, url, title, raw) {
  fs.mkdirSync(out(), { recursive: true });
  const at = stamp(new Date());
  const m = manifest();
  const file = String(m.shots.length + 1).padStart(2, '0') + '-' + slug(title) + '.png';
  const frame = await page.context().newPage();
  await frame.setContent(frameHtml({ url, at, image: 'data:image/png;base64,' + Buffer.from(raw).toString('base64') }));
  await frame.screenshot({ path: path.join(out(), file), fullPage: true });
  await frame.close();
  m.shots.push({ file, title: String(title), url: String(url), at });
  fs.writeFileSync(manifestFile(), JSON.stringify(m, null, 2));
}
/** A print of the page as it is now, framed with its URL and the time. */
async function shot(page, title) {
  return framed(page, page.url(), title, await page.screenshot({ fullPage: true }));
}
/** A print of an API call laid out like Swagger (curl, request URL, status, body), framed. */
async function apiShot(page, call) {
  const { title, method = 'GET', url, headers = {}, body, status, response } = call;
  const h = maskHeaders(headers);
  const curl = ["curl -X '" + method + "' '" + url + "'"]
    .concat(Object.entries(h).map(([k, v]) => "  -H '" + k + ': ' + v + "'"))
    .concat(body === undefined ? [] : ["  -d '" + (typeof body === 'string' ? body : JSON.stringify(body)) + "'"])
    .join(' \\\n');
  const shown = typeof response === 'string' ? response : JSON.stringify(response, null, 2);
  const view = await page.context().newPage();
  await view.setContent('<!doctype html><meta charset="utf-8"><body style="font:13px monospace;padding:16px;background:#fafafa">' +
    '<h4>Curl</h4><pre style="background:#333;color:#fff;padding:10px;white-space:pre-wrap">' + esc(curl) + '</pre>' +
    '<h4>Request URL</h4><pre style="background:#333;color:#fff;padding:10px">' + esc(url) + '</pre>' +
    '<h4>Server response: ' + esc(status) + '</h4>' +
    '<pre style="background:#333;color:#9f9;padding:10px;white-space:pre-wrap">' + esc(shown) + '</pre></body>');
  const raw = await view.screenshot({ fullPage: true });
  await view.close();
  return framed(page, url, title, raw);
}
module.exports = { maskHeaders, stamp, frameHtml, shot, apiShot };
`;
/**
 * Runs the agent's roteiro.cjs in the official Playwright image of the pinned version, on the
 * host network so it reaches the system the agent started in the workspace.
 */
export const RUN_SH = [
  '#!/bin/sh',
  'set -eu',
  'here=$(cd "$(dirname "$0")" && pwd)',
  'version=$(cat "$here/version")',
  'tz=$(cat "$here/timezone" 2>/dev/null || echo UTC)',
  'rm -rf "$here/out" && mkdir -p "$here/out"',
  // As the workspace user (the image defaults to root, whose files the workspace could not
  // remove), with Playwright installed under /tmp: only out/ is written in the kit folder.
  'exec docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \\',
  '  -e TZ="$tz" -e EVIDENCE_TZ="$tz" -e EVIDENCE_OUT=/evidence/out \\',
  '  -v "$here:/evidence" -w /evidence "mcr.microsoft.com/playwright:v${version}-noble" \\',
  '  sh -c "cd /tmp && npm i --no-save --no-audit --no-fund --no-package-lock playwright@${version} >/dev/null && NODE_PATH=/tmp/node_modules node /evidence/roteiro.cjs"',
  '',
].join('\n');
