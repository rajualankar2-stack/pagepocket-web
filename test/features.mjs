/**
 * Exhaustive feature test.
 *
 * Every interactive control, every option, every edge case. Written after a
 * report of "so many bugs" — the goal is to find real breakage, so this asserts
 * on observable outcomes rather than merely that a click did not throw.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8898/';

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; failures.push(name + (extra ? '  ' + extra : '')); console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};
const section = (t) => console.log('\n=== ' + t + ' ===');

const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));

await page.goto(BASE, { waitUntil: 'networkidle' });

const setEditor = async (html) => {
  await page.evaluate((h) => {
    const ed = document.getElementById('editor');
    ed.value = h;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }, html);
};
const closeDialogs = () => page.evaluate(() => {
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
});
const consoleText = () => page.innerText('#console-body');

/* ---------------------------------------------------------------- */
section('1. Load and initial state');

check('no page errors on load', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('title is set', (await page.title()).includes('PagePocket'), await page.title());
check('editor is present and empty', (await page.inputValue('#editor')) === '');
check('output shows placeholder', !(await page.locator('#frame-empty').getAttribute('class') || '').includes('hidden'));
check('status starts idle', (await page.innerText('#status')) === 'idle', await page.innerText('#status'));
check('editor size shows 0 B', (await page.innerText('#editor-meta')) === '0 B', await page.innerText('#editor-meta'));
check('console starts empty', (await consoleText()).includes('Messages from the page'));

/* ---------------------------------------------------------------- */
section('2. Running simple markup');

await setEditor('<html><body><h1>HELLO</h1></body></html>');
await page.click('#btn-run');
await page.waitForTimeout(1200);
check('renders h1', (await page.frameLocator('#preview').locator('h1').innerText()) === 'HELLO');
check('status becomes ok', (await page.innerText('#status')) === 'ok', await page.innerText('#status'));
check('placeholder hidden after run', (await page.locator('#frame-empty').getAttribute('class') || '').includes('hidden'));
check('output size shown', (await page.innerText('#output-meta')).includes('B'), await page.innerText('#output-meta'));

/* ---------------------------------------------------------------- */
section('3. Fragment wrapping (Wrap fragments option)');

await setEditor('<p>bare</p>');
await page.click('#btn-run');
await page.waitForTimeout(900);
const wrappedMeta = await page.innerText('#output-meta');
check('fragment renders', (await page.frameLocator('#preview').locator('p').innerText()) === 'bare');
check('fragment gets a viewport meta', await page.frameLocator('#preview').locator('meta[name=viewport]').count() > 0);

await page.uncheck('#opt-wrap');
await page.click('#btn-run');
await page.waitForTimeout(900);
const noWrapMeta = await page.innerText('#output-meta');
check('unwrapped is smaller than wrapped', sizeOf(noWrapMeta) < sizeOf(wrappedMeta),
      `${noWrapMeta} vs ${wrappedMeta}`);
check('fragment still renders unwrapped', (await page.frameLocator('#preview').locator('p').innerText()) === 'bare');
await page.check('#opt-wrap');

function sizeOf(meta) { const m = /([\d,]+) B/.exec(meta); return m ? Number(m[1].replace(/,/g, '')) : 0; }

/* ---------------------------------------------------------------- */
section('4. Console capture (each level)');

await setEditor(`<html><body><script>
  console.log('L-one', {a:1});
  console.info('L-two');
  console.warn('L-three');
  console.error('L-four');
  console.debug('L-five');
</script></body></html>`);
await page.click('#btn-run');
await page.waitForTimeout(1300);
const c = await consoleText();
check('log captured', c.includes('L-one') && c.includes('{"a":1}'), '');
check('info captured', c.includes('L-two'));
check('warn captured', c.includes('L-three'));
check('error captured', c.includes('L-four'));
check('debug captured and mapped to log', c.includes('L-five'));
check('console count increments', Number(await page.innerText('#console-count')) >= 5,
      await page.innerText('#console-count'));

/* ---------------------------------------------------------------- */
section('5. Uncaught errors and rejections');

await setEditor(`<html><body><script>
  setTimeout(() => { throw new Error('ASYNC-BOOM'); }, 10);
  Promise.reject(new Error('REJECTED'));
</script></body></html>`);
await page.click('#btn-run');
await page.waitForTimeout(1500);
const e = await consoleText();
check('uncaught error captured', e.includes('ASYNC-BOOM'), '');
check('unhandled rejection captured', e.includes('REJECTED'));

/* ---------------------------------------------------------------- */
section('6. Console option off means no capture');

await page.uncheck('#opt-console');
await setEditor('<html><body><script>console.log("SHOULD-NOT-APPEAR")</script></body></html>');
await page.click('#btn-run');
await page.waitForTimeout(1200);
const offText = await consoleText();
check('no capture when disabled', !offText.includes('SHOULD-NOT-APPEAR'), offText.slice(0, 60));
check('page still renders with console off',
      await page.frameLocator('#preview').locator('body').count() > 0);
await page.check('#opt-console');

/* ---------------------------------------------------------------- */
section('7. Clear console');

await setEditor('<html><body><script>console.log("TO-CLEAR")</script></body></html>');
await page.click('#btn-run');
await page.waitForTimeout(1100);
await page.click('#btn-clear-console');
await page.waitForTimeout(300);
check('console cleared', !(await consoleText()).includes('TO-CLEAR'));
check('count reset to 0', (await page.innerText('#console-count')) === '0');

/* ---------------------------------------------------------------- */
section('8. Stale console messages do not leak between runs');

await setEditor('<html><body><script>console.log("RUN-A")</script></body></html>');
await page.click('#btn-run');
await page.waitForTimeout(1100);
await setEditor('<html><body><script>console.log("RUN-B")</script></body></html>');
await page.click('#btn-run');
await page.waitForTimeout(1300);
const runs = await consoleText();
check('previous run cleared on new run', !runs.includes('RUN-A'), runs.replace(/\n/g, ' ').slice(0, 80));
check('current run captured', runs.includes('RUN-B'));

/* ---------------------------------------------------------------- */
section('9. Empty input handling');

await page.evaluate(() => {
  const ed = document.getElementById('editor');
  ed.value = '';
  ed.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#btn-run');
await page.waitForTimeout(500);
check('empty run shows a toast', (await page.innerText('#toast')).length > 0, await page.innerText('#toast'));

await page.evaluate(() => {
  const ed = document.getElementById('editor');
  ed.value = '   \n\t  ';
  ed.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#btn-run');
await page.waitForTimeout(400);
check('whitespace-only run is refused', (await page.innerText('#toast')).length > 0);

/* ---------------------------------------------------------------- */
section('10. Keyboard shortcuts');

await setEditor('<html><body><h2>KEYBOARD</h2></body></html>');
await page.click('#editor');
await page.keyboard.press('Meta+Enter');
await page.waitForTimeout(1100);
check('Cmd+Enter runs', (await page.frameLocator('#preview').locator('h2').innerText()) === 'KEYBOARD');

// Tab inserts spaces rather than moving focus
await page.evaluate(() => {
  const ed = document.getElementById('editor');
  ed.value = 'a';
  ed.selectionStart = ed.selectionEnd = 1;
  ed.focus();
});
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
const afterTab = await page.inputValue('#editor');
check('Tab inserts two spaces', afterTab === 'a  ', JSON.stringify(afterTab));
check('Tab does not move focus out of editor',
      await page.evaluate(() => document.activeElement.id === 'editor'));

/* ---------------------------------------------------------------- */
section('11. Line-number gutter');

await setEditor('l1\nl2\nl3\nl4\nl5');
await page.waitForTimeout(300);
const gutter = await page.innerText('#gutter');
check('gutter shows a number per line', gutter.split('\n').filter(Boolean).length === 5, JSON.stringify(gutter));
const align = await page.evaluate(() => {
  const g = getComputedStyle(document.getElementById('gutter'));
  const e = getComputedStyle(document.getElementById('editor'));
  return { gf: g.fontSize, ef: e.fontSize, gl: g.lineHeight, el: e.lineHeight, gp: g.paddingTop, ep: e.paddingTop };
});
check('gutter font matches editor', align.gf === align.ef, `${align.gf} vs ${align.ef}`);
check('gutter line-height matches editor', align.gl === align.el, `${align.gl} vs ${align.el}`);
check('gutter padding matches editor', align.gp === align.ep, `${align.gp} vs ${align.ep}`);

/* ---------------------------------------------------------------- */
section('12. Editor byte counter');

await setEditor('abc');
await page.waitForTimeout(200);
check('counts 3 bytes', (await page.innerText('#editor-meta')) === '3 B', await page.innerText('#editor-meta'));
await setEditor('é');   // 2 bytes in UTF-8
await page.waitForTimeout(200);
check('counts UTF-8 bytes correctly', (await page.innerText('#editor-meta')) === '2 B',
      await page.innerText('#editor-meta') + ' (expected 2 B for é)');

/* ---------------------------------------------------------------- */
section('13. Reload button');

await setEditor('<html><body><h3>RELOADED</h3></body></html>');
await page.click('#btn-run');
await page.waitForTimeout(1000);
await page.click('#btn-reload');
await page.waitForTimeout(1100);
check('reload re-renders', (await page.frameLocator('#preview').locator('h3').innerText()) === 'RELOADED');

/* ---------------------------------------------------------------- */
section('14. Samples dialog');

await page.click('#btn-samples');
await page.waitForTimeout(400);
check('samples dialog opens', await page.locator('#samples-dialog').evaluate(d => d.open));
const sampleCount = await page.locator('#sample-list .sample').count();
check('samples are listed', sampleCount === 3, `${sampleCount} samples`);

// Load each sample and confirm it runs without error. Read the names first so
// each iteration only opens the dialog once.
const sampleNames = await page.locator('#sample-list .sample strong').allInnerTexts();
await closeDialogs();
for (let i = 0; i < sampleCount; i++) {
  await page.click('#btn-samples');
  await page.waitForTimeout(350);
  await page.locator('#sample-list .sample').nth(i).click();
  await page.waitForTimeout(1700);
  // The handler must close the dialog; if it does not, the next click is
  // blocked, which is exactly the kind of bug this run is looking for.
  const stillOpen = await page.locator('#samples-dialog').evaluate(d => d.open);

  // "Runs" cannot mean "has body text": the canvas sample renders only a
  // <canvas>, which has none. Check that the frame has real DOM instead.
  const bodyChildren = await page.frameLocator('#preview').locator('body > *').count();
  const editorFilled = (await page.inputValue('#editor')).length > 100;

  check(`sample "${sampleNames[i]}" loads into the editor`, editorFilled);
  check(`sample "${sampleNames[i]}" renders DOM`, bodyChildren > 0, `${bodyChildren} elements`);
  check(`sample "${sampleNames[i]}" closes the dialog`, !stillOpen);

  // The "Console & errors" sample throws on purpose, so an error there is the
  // point of the sample rather than a failure. Only flag errors elsewhere.
  const logs = await consoleText();
  if (sampleNames[i].includes('Console')) {
    check(`sample "${sampleNames[i]}" demonstrates all console levels`,
          logs.includes('sample ready') && logs.toLowerCase().includes('error'),
          'expected deliberate errors');
  } else {
    check(`sample "${sampleNames[i]}" logs no errors`,
          !logs.toLowerCase().includes('error'), logs.slice(0, 60));
  }
  await closeDialogs();
}

/* ---------------------------------------------------------------- */
section('15. Download');

const dl = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
await setEditor('<html><head><title>Download Me</title></head><body>x</body></html>');
await page.click('#btn-download');
const download = await dl;
check('download event fires', !!download, download ? '' : 'no download');
if (download) {
  check('filename derived from <title>', download.suggestedFilename() === 'Download Me.html',
        download.suggestedFilename());
}

/* ---------------------------------------------------------------- */
section('16. Full screen (immersive)');

await setEditor('<html><body><h1>IMMERSIVE</h1></body></html>');
await page.click('#btn-run');
await page.waitForTimeout(1000);

await page.click('#btn-immersive');
await page.waitForTimeout(400);
check('body enters immersive class', await page.evaluate(() => document.body.classList.contains('immersive')));
check('topbar hidden in immersive', !(await page.locator('.topbar').isVisible()));
check('editor hidden in immersive', !(await page.locator('.editor-pane').isVisible()));
check('console hidden in immersive', !(await page.locator('.console').isVisible()));
check('preview still visible in immersive', await page.locator('#preview').isVisible());
check('preview fills viewport', await page.evaluate(() => {
  const r = document.getElementById('preview').getBoundingClientRect();
  return r.height > window.innerHeight * 0.8;
}));
check('page still renders in immersive',
      (await page.frameLocator('#preview').locator('h1').innerText()) === 'IMMERSIVE');

// There must be an explicit, visible way out. "Click anywhere" is not enough:
// the previewed page swallows clicks inside its own frame, which previously
// left a user stuck in full screen with every control hidden.
check('exit button is visible while immersive', await page.locator('#btn-exit-immersive').isVisible());

// A stray click inside the page must not be required for exit, and must not
// leave the user stranded either.
await page.mouse.click(600, 500);
await page.waitForTimeout(300);
check('exit button still reachable after a stray click',
      await page.locator('#btn-exit-immersive').isVisible());

await page.click('#btn-exit-immersive');
await page.waitForTimeout(500);
check('exit button leaves immersive', !(await page.evaluate(() => document.body.classList.contains('immersive'))));
check('topbar visible again', await page.locator('.topbar').isVisible());

// Escape should also exit.
await page.click('#btn-immersive');
await page.waitForTimeout(400);
check('re-enters immersive', await page.evaluate(() => document.body.classList.contains('immersive')));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
check('Escape exits immersive', !(await page.evaluate(() => document.body.classList.contains('immersive'))));

/* ---------------------------------------------------------------- */
section('17. Share link');

await setEditor('<html><body><h1>SHARED-CONTENT</h1></body></html>');
await page.click('#btn-share');
await page.waitForTimeout(700);
check('share dialog opens', await page.locator('#share-dialog').evaluate(d => d.open));
const shareUrl = await page.inputValue('#share-url');
check('share url contains fragment', shareUrl.includes('#h='), shareUrl.slice(0, 60) + '…');
check('fragment, not query, so it never reaches a server', !shareUrl.includes('?h='));
check('share info explains the size', (await page.innerText('#share-info')).length > 10);

await page.click('#btn-copy-share');
await page.waitForTimeout(500);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
check('copy puts the link on the clipboard', clip.includes('#h='), clip.slice(0, 50) + '…');

// Round-trip in a fresh page
const page2 = await ctx.newPage();
await page2.goto(shareUrl, { waitUntil: 'networkidle' });
await page2.waitForTimeout(1500);
check('share link restores markup', (await page2.inputValue('#editor')).includes('SHARED-CONTENT'));
check('share link auto-runs', await page2.frameLocator('#preview').locator('h1').count() > 0);
await page2.close();
await closeDialogs();

/* ---------------------------------------------------------------- */
section('18. Open file');

const tmpFile = '/tmp/ppw-open-test.html';
await page.waitForTimeout(200);
const chooser = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null);
await page.click('#btn-open');
const fc = await chooser;
check('file chooser opens', !!fc);
if (fc) {
  await fc.setFiles({
    name: 'opened.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<html><body><h1>OPENED-FILE</h1></body></html>'),
  });
  await page.waitForTimeout(1500);
  check('opened file loads into editor', (await page.inputValue('#editor')).includes('OPENED-FILE'));
  check('opened file renders', (await page.frameLocator('#preview').locator('h1').innerText()) === 'OPENED-FILE');
}

/* ---------------------------------------------------------------- */
section('19. Drag and drop');

await setEditor('');
const dt = await page.evaluateHandle(() => {
  const dt = new DataTransfer();
  dt.items.add(new File(['<html><body><h1>DROPPED</h1></body></html>'], 'dropped.html', { type: 'text/html' }));
  return dt;
});
await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
await page.waitForTimeout(1600);
check('dropped file loads', (await page.inputValue('#editor')).includes('DROPPED'),
      (await page.inputValue('#editor')).slice(0, 40));
check('dropped file renders',
      (await page.frameLocator('#preview').locator('h1').innerText().catch(() => '')) === 'DROPPED');

/* ---------------------------------------------------------------- */
section('20. Auto-run');

await page.check('#opt-autorun');
await setEditor('<html><body><h1>AUTO-ONE</h1></body></html>');
await page.waitForTimeout(1600);
check('auto-run fires while typing',
      (await page.frameLocator('#preview').locator('h1').innerText().catch(() => '')) === 'AUTO-ONE');
await page.uncheck('#opt-autorun');

/* ---------------------------------------------------------------- */
section('21. Edge-case markup');

const edgeCases = [
  ['empty body', '<html><body></body></html>'],
  ['no html wrapper at all', 'just text'],
  ['unclosed tags', '<html><body><div><p>unclosed'],
  ['doctype only', '<!DOCTYPE html>'],
  ['unicode + emoji', '<html><body><h1>日本語 🎉 é</h1></body></html>'],
  ['style block', '<html><head><style>body{background:rgb(1,2,3)}</style></head><body>x</body></html>'],
  ['nested iframe', '<html><body><iframe srcdoc="&lt;b&gt;inner&lt;/b&gt;"></iframe></body></html>'],
  ['svg inline', '<html><body><svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg></body></html>'],
  ['base64 image', '<html><body><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></body></html>'],
  ['very long line', '<html><body>' + 'x'.repeat(20000) + '</body></html>'],
];
for (const [label, html] of edgeCases) {
  const before = pageErrors.length;
  await setEditor(html);
  await page.click('#btn-run');
  await page.waitForTimeout(800);
  const newErrs = pageErrors.length - before;
  const rendered = await page.frameLocator('#preview').locator('body').count() > 0;
  check(`edge case: ${label}`, rendered && newErrs === 0, newErrs ? pageErrors.slice(-1)[0] : '');
}

/* ---------------------------------------------------------------- */
section('22. Security invariants still hold');

const sandbox = await page.getAttribute('#preview', 'sandbox');
check('allow-same-origin never set', !sandbox.includes('allow-same-origin'), sandbox);
check('allow-scripts set', sandbox.includes('allow-scripts'));

await setEditor('<html><body><script>try{parent.document.title;console.log("P=LEAK")}catch(e){console.log("P=blocked")}</script></body></html>');
await page.click('#btn-run');
await page.waitForTimeout(1300);
check('parent DOM still blocked', (await consoleText()).includes('P=blocked'));

/* ---------------------------------------------------------------- */
section('23. Frame uses a blob URL, not srcdoc');

await setEditor('<html><body>x</body></html>');
await page.click('#btn-run');
await page.waitForTimeout(900);
const frameInfo = await page.evaluate(() => {
  const f = document.getElementById('preview');
  return { src: f.src, srcdoc: f.srcdoc };
});
check('frame uses blob: URL', frameInfo.src.startsWith('blob:'), frameInfo.src.slice(0, 40));
check('srcdoc not used (it would inherit the host CSP)', frameInfo.srcdoc === '', JSON.stringify(frameInfo.srcdoc));

/* ---------------------------------------------------------------- */
section('24. No unexpected page errors in the app itself');

// Several tests above deliberately throw (the async/rejection capture tests and
// the "Console & errors" sample). Those errors belong to the *previewed page*,
// not to this app, and the harness already asserted they were captured. What
// must never happen is an error originating in the app's own code, so filter
// out the ones the fixtures raise on purpose.
const DELIBERATE = ['REJECTED', 'ASYNC-BOOM', 'rejected on purpose', 'deliberate explosion'];
const appErrors = pageErrors.filter(e => !DELIBERATE.some(d => e.includes(d)));

check('no unexpected errors from the app', appErrors.length === 0,
      appErrors.slice(0, 3).join(' | '));
if (appErrors.length) {
  console.log('    (filtered out ' + (pageErrors.length - appErrors.length) +
              ' deliberate fixture errors)');
}

/* ---------------------------------------------------------------- */
await browser.close();

console.log(`\n${'='.repeat(60)}`);
console.log(`${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);
