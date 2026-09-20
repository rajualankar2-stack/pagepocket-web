import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8898/';
let pass = 0, fail = 0;
const check = (name, ok, extra='') => {
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  ok ? pass++ : fail++;
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
console.log('--- 1. the app loads cleanly ---');
check('no page errors on load', errors.length === 0, errors.slice(0,3).join(' | '));

console.log('\n--- 2. the sandbox attribute is what we think it is ---');
const sandbox = await page.getAttribute('#preview', 'sandbox');
check('sandbox present', !!sandbox, sandbox);
check('allow-scripts is set', sandbox.includes('allow-scripts'));
check('allow-same-origin is NOT set', !sandbox.includes('allow-same-origin'),
      'critical: this is what gives the frame an opaque origin');
check('allow-top-navigation not set', !sandbox.includes('allow-top-navigation'));
check('allow-popups not set', !sandbox.includes('allow-popups'));

console.log('\n--- 3. a hostile document cannot reach the parent ---');
// Build the probe without a literal closing script tag in this file.
const S = String.fromCharCode(60) + '/script' + String.fromCharCode(62);
const hostile = [
  '<html><body>',
  '<' + 'script>',
  'var r = {};',
  'try { var t = parent.document.title; r.parentDom = "LEAKED:" + t; } catch (e) { r.parentDom = "blocked:" + e.name; }',
  'try { localStorage.setItem("x","1"); r.storage = "WRITABLE"; } catch (e) { r.storage = "blocked:" + e.name; }',
  'try { r.origin = String(location.origin); } catch (e) { r.origin = "blocked"; }',
  'try { parent.localStorage.getItem("x"); r.hostStorage = "REACHED"; } catch (e) { r.hostStorage = "blocked"; }',
  'parent.postMessage({ __probe: true, results: r }, "*");',
  S,
  '</body></html>'
].join('\n');
await page.evaluate((m) => {
  const ed = document.getElementById('editor');
  ed.value = m;
  ed.dispatchEvent(new Event('input', { bubbles: true }));
}, hostile);
await page.click('#btn-run');
const probe = await page.evaluate(() => new Promise(res => {
  const h = (e) => { if (e.data && e.data.__probe) { window.removeEventListener('message', h); res(e.data.results); } };
  window.addEventListener('message', h);
  setTimeout(() => res(null), 8000);
}));
if (!probe) {
  const dbg = await page.evaluate(() => ({
    srcdocLen: (document.getElementById('preview').srcdoc || '').length,
    srcdocTail: (document.getElementById('preview').srcdoc || '').slice(-260),
    status: document.getElementById('status').textContent,
  }));
  console.log('    DEBUG srcdocLen=' + dbg.srcdocLen + ' status=' + dbg.status);
  console.log('    DEBUG tail=' + JSON.stringify(dbg.srcdocTail));
}
check('probe returned', !!probe);
if (probe) {
  check('cannot read parent DOM', String(probe.parentDom).startsWith('blocked'), probe.parentDom);
  check('localStorage not writable', String(probe.storage).startsWith('blocked'), probe.storage);
  // Note: a blob: frame echoes its creator's origin *string* even when
  // sandboxed, so `location.origin` is NOT the security property here and is
  // deliberately not asserted. What matters is whether that origin is usable to
  // reach the host, which is what the checks below establish.
  check('cannot reach host storage', probe.hostStorage === 'blocked', String(probe.hostStorage));
}

console.log('\n--- 4. console capture works ---');
await page.fill('#editor', `<html><body><script>
  console.log('hello from page');
  console.warn('a warning');
  console.error('an error');
<\/script></body></html>`);
await page.click('#btn-run');
await page.waitForTimeout(1200);
const consoleText = await page.innerText('#console-body');
check('captured console.log', consoleText.includes('hello from page'));
check('captured console.warn', consoleText.includes('a warning'));
check('captured console.error', consoleText.includes('an error'));

console.log('\n--- 5. rendering works at all ---');
await page.fill('#editor', '<html><body><h1>RENDER-MARKER</h1></body></html>');
await page.click('#btn-run');
await page.waitForTimeout(900);
const frameText = await page.frameLocator('#preview').locator('h1').innerText();
check('markup renders in the frame', frameText.includes('RENDER-MARKER'), frameText);

console.log('\n--- 6. fragment auto-wrapping ---');
await page.fill('#editor', '<p>bare fragment</p>');
await page.click('#btn-run');
await page.waitForTimeout(900);
const wrapped = await page.frameLocator('#preview').locator('p').innerText();
check('a fragment still renders as a page', wrapped.includes('bare fragment'));

console.log('\n--- 7. share link round-trip ---');
await page.fill('#editor', '<html><body><h1>SHARE-ME</h1></body></html>');
await page.click('#btn-share');
await page.waitForTimeout(600);
const shareUrl = await page.inputValue('#share-url');
check('share url produced', shareUrl.includes('#h='), shareUrl.slice(0, 70) + '…');
await page.goto(shareUrl, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const restored = await page.inputValue('#editor');
check('share link restores the markup', restored.includes('SHARE-ME'));

console.log('\n--- 8. no network calls leave the page ---');
const requests = [];
const page2 = await browser.newPage();
page2.on('request', r => {
  const u = r.url();
  // blob: URLs are the preview frame itself, not a network call.
  if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return;
  requests.push(u);
});
await page2.goto(BASE, { waitUntil: 'networkidle' });
await page2.fill('#editor', '<html><body>hi</body></html>');
await page2.click('#btn-run');
await page2.waitForTimeout(1500);
check('no external requests', requests.length === 0, requests.slice(0,3).join(' | '));


// The share flow leaves a modal open; dismiss it or it intercepts every
// subsequent click.
await page.evaluate(() => {
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
});

console.log('\n--- 9. inline scripts run under the real CSP ---');
// The previewed document inherits the host Content-Security-Policy. A
// `script-src` without 'unsafe-inline' renders markup but executes none of it,
// which is exactly how a broken build reached production once. This asserts the
// capability directly so it cannot regress silently.
await page.fill('#editor', '<html><body><h1>csp</h1><scr' + 'ipt>parent.postMessage({__inline:true},"*")</scr' + 'ipt></body></html>');
await page.click('#btn-run');
const inlineRan = await page.evaluate(() => new Promise(res => {
  const h = e => { if (e.data && e.data.__inline) { window.removeEventListener('message', h); res(true); } };
  window.addEventListener('message', h);
  setTimeout(() => res(false), 6000);
}));
check('inline script in the preview executes', inlineRan === true,
      inlineRan ? '' : 'host CSP is blocking it — check script-src');

console.log('\n--- 10. the served CSP matches vercel.json ---');
const servedCsp = await page.evaluate(async () => {
  const r = await fetch(location.href, { method: 'GET' });
  return r.headers.get('content-security-policy');
});
check('CSP header present', !!servedCsp, servedCsp ? servedCsp.slice(0, 60) + '…' : 'none');
if (servedCsp) {
  check("CSP permits the preview's inline scripts", servedCsp.includes("'unsafe-inline'"));
  check('CSP keeps default-src locked to self', servedCsp.includes("default-src 'self'"));
  check('CSP blocks form submissions', servedCsp.includes("form-action 'none'"));
}

await browser.close();
console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
