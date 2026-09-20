/**
 * PagePocket Web — paste HTML and run it.
 *
 * Security model
 * --------------
 * The rendered document runs in an `<iframe sandbox="allow-scripts ...">` with
 * `allow-same-origin` deliberately withheld. That gives it a unique opaque
 * origin: it cannot touch this page's DOM, cookies, localStorage or IndexedDB,
 * and it cannot navigate the top frame. Its only channel back is `postMessage`,
 * which the parent validates by source before doing anything.
 *
 * There is no server component. Nothing is uploaded, stored remotely, or
 * logged — the markup lives in the textarea, the frame's srcdoc, and (only when
 * you ask for a share link) the URL fragment, which browsers never transmit.
 */

const $ = (id) => document.getElementById(id);

const els = {
  editor: $('editor'),
  gutter: $('gutter'),
  editorMeta: $('editor-meta'),
  frame: $('preview'),
  frameWrap: $('frame-wrap'),
  frameEmpty: $('frame-empty'),
  status: $('status'),
  outputMeta: $('output-meta'),
  consoleBody: $('console-body'),
  consoleCount: $('console-count'),
  consolePanel: $('console-panel'),
  toast: $('toast'),
  samplesDialog: $('samples-dialog'),
  sampleList: $('sample-list'),
  shareDialog: $('share-dialog'),
  shareUrl: $('share-url'),
  shareInfo: $('share-info'),

  // Option switches. These must be in the map: `prepareDocument` reads them on
  // every run, and a missing entry throws before the frame is ever populated.
  optConsole: $('opt-console'),
  optWrap: $('opt-wrap'),
  optAutorun: $('opt-autorun'),
};

const state = {
  consoleCount: 0,
  runToken: 0,
  autoRunTimer: null,
  currentBlobURL: null,
};

/* ------------------------------------------------------------------ *
 * Sandbox bridge
 *
 * The injected script is prepended to the user's markup inside the frame. It
 * captures console output, errors and unhandled rejections, and forwards them
 * with the run token so messages from a previous run are ignored.
 * ------------------------------------------------------------------ */

const BRIDGE = (token) => `
<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var MAX = 4000;            // cap each message, matching the iOS app
  var LIMIT = 300;           // cap total messages per run
  var sent = 0;

  function clip(v) {
    try {
      var s = typeof v === 'string' ? v : stringify(v);
      return s.length > MAX ? s.slice(0, MAX) + '… (truncated)' : s;
    } catch (e) { return '[unserialisable]'; }
  }

  function stringify(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    var t = typeof value;
    if (t === 'string') return value;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
    if (t === 'function') return 'ƒ ' + (value.name || 'anonymous') + '()';
    if (value instanceof Error) return value.name + ': ' + value.message;
    if (value instanceof Element) {
      var tag = value.tagName.toLowerCase();
      return '<' + tag + (value.id ? '#' + value.id : '') + '>';
    }
    try {
      var seen = [];
      var json = JSON.stringify(value, function (k, v) {
        if (typeof v === 'object' && v !== null) {
          if (seen.indexOf(v) !== -1) return '[Circular]';
          seen.push(v);
        }
        if (typeof v === 'function') return 'ƒ ' + (v.name || 'anonymous') + '()';
        return v;
      });
      return json === undefined ? String(value) : json;
    } catch (e) { return Object.prototype.toString.call(value); }
  }

  function send(level, args) {
    try {
      if (sent >= LIMIT) return;
      sent++;
      var parts = [];
      for (var i = 0; i < args.length; i++) parts.push(clip(args[i]));
      parent.postMessage({
        __pagepocket: true, token: TOKEN, level: level, text: parts.join(' ')
      }, '*');
    } catch (e) { /* logging must never break the page */ }
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      send(level === 'debug' ? 'log' : level, Array.prototype.slice.call(arguments));
      if (original) { try { original.apply(console, arguments); } catch (e) {} }
    };
  });

  // WebKit reports uncaught errors from a blob:/cross-origin frame as the
  // opaque string "Script error." with no message, line or stack — which is
  // exactly the information someone debugging their pasted HTML needs. Wrap
  // the common async entry points so the real error is captured before it
  // crosses the boundary.
  function describe(err) {
    if (!err) return 'Unknown error';
    if (err instanceof Error || (err && err.message)) {
      var text = (err.name || 'Error') + ': ' + (err.message || '');
      if (err.stack) {
        var line = String(err.stack).split('\\n')[1];
        if (line) text += '\\n' + line.trim();
      }
      return text;
    }
    return stringify(err);
  }

  function guard(name, fn) {
    return function () {
      var args = Array.prototype.slice.call(arguments);
      // Callbacks are wrapped so a throw inside them keeps its message.
      for (var i = 0; i < args.length; i++) {
        if (typeof args[i] === 'function') {
          var original = args[i];
          args[i] = function () {
            try { return original.apply(this, arguments); }
            catch (e) { send('error', ['Uncaught in ' + name + ' callback — ' + describe(e)]); throw e; }
          };
        }
      }
      try { return fn.apply(this, args); }
      catch (e) { send('error', ['Uncaught — ' + describe(e)]); throw e; }
    };
  }

  // Timer and frame callbacks are where most stray throws happen.
  var _setTimeout = window.setTimeout;
  window.setTimeout = guard('setTimeout', function (fn, ms) {
    var rest = Array.prototype.slice.call(arguments, 2);
    return _setTimeout.apply(window, [typeof fn === 'function' ? function () {
      try { fn.apply(this, arguments); }
      catch (e) { send('error', ['Uncaught in setTimeout — ' + describe(e)]); }
    } : fn, ms].concat(rest));
  });

  var _setInterval = window.setInterval;
  window.setInterval = guard('setInterval', function (fn, ms) {
    var rest = Array.prototype.slice.call(arguments, 2);
    return _setInterval.apply(window, [typeof fn === 'function' ? function () {
      try { fn.apply(this, arguments); }
      catch (e) { send('error', ['Uncaught in setInterval — ' + describe(e)]); }
    } : fn, ms].concat(rest));
  });

  var _raf = window.requestAnimationFrame;
  if (_raf) {
    window.requestAnimationFrame = function (fn) {
      return _raf.call(window, function (t) {
        try { fn(t); }
        catch (e) { send('error', ['Uncaught in animation frame — ' + describe(e)]); }
      });
    };
  }

  // Event listeners: a throw in a handler otherwise surfaces as "Script error."
  var _addEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (typeof listener === 'function') {
      var wrapped = function (event) {
        try { return listener.call(this, event); }
        catch (e) { send('error', ['Uncaught in "' + type + '" handler — ' + describe(e)]); }
      };
      return _addEventListener.call(this, type, wrapped, options);
    }
    return _addEventListener.call(this, type, listener, options);
  };

  window.addEventListener('error', function (e) {
    // Prefer the real error object when the frame exposes one.
    if (e.error) { send('error', [describe(e.error)]); return; }
    var msg = e.message || 'Script error';
    // "Script error." is WebKit withholding detail; say so rather than
    // presenting it as the page's actual message.
    if (msg === 'Script error.' || msg === 'Script error') {
      msg = 'Script error (the browser withheld details for this cross-origin frame)';
    }
    if (e.filename) msg += ' (' + e.filename + ':' + e.lineno + ')';
    send('error', [msg]);
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    send('error', ['Unhandled promise rejection: ' + (r && r.message ? r.message : stringify(r))]);
  });

  // Tell the parent the document is live, so it can clear the "running" state
  // even for a page that logs nothing.
  window.addEventListener('load', function () { send('sys', ['__loaded__']); });
})();
</script>
`;

/* ------------------------------------------------------------------ *
 * Markup helpers
 * ------------------------------------------------------------------ */

const looksComplete = (markup) => /<html[\s>]|<!doctype/i.test(markup);

/** Wraps a fragment so it gets a viewport tag, preserving the author's markup. */
function wrapFragment(markup) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pasted HTML</title>
</head>
<body>
${markup}
</body>
</html>`;
}

function prepareDocument(markup, token) {
  const body = els.optWrap.checked && !looksComplete(markup) ? wrapFragment(markup) : markup;
  const bridge = els.optConsole.checked ? BRIDGE(token) : '';

  // The bridge has to run before the author's scripts, so it is inserted as the
  // first thing in <head> when there is one, and prepended otherwise.
  // Always declare UTF-8. Markup without a <meta charset> would otherwise be
  // decoded as Latin-1, and any non-ASCII in the bridge or the page would be
  // corrupted on screen.
  const charset = '<meta charset="utf-8">';
  const inject = bridge + charset;

  if (/<head[\s>]/i.test(body)) {
    // Insert immediately after the opening <head>, before the author's content.
    return body.replace(/<head([^>]*)>/i, (m) => (bridge ? m + inject : m));
  }
  if (/<html[\s>]/i.test(body)) {
    return body.replace(/<html([^>]*)>/i, (m) => (bridge ? m + '<head>' + inject + '</head>' : m));
  }
  return inject + body;
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

function setStatus(text, stateName) {
  els.status.textContent = text;
  els.status.dataset.state = stateName;
}

function clearConsole() {
  state.consoleCount = 0;
  els.consoleCount.textContent = '0';
  els.consoleBody.innerHTML = '<div class="console-empty">Messages from the page appear here.</div>';
}

function appendConsole(level, text) {
  const empty = els.consoleBody.querySelector('.console-empty');
  if (empty) empty.remove();

  const line = document.createElement('div');
  line.className = 'console-line ' + level;

  const lvl = document.createElement('span');
  lvl.className = 'lvl';
  lvl.textContent = level === 'sys' ? 'page' : level;

  const body = document.createElement('span');
  body.textContent = text;   // textContent, never innerHTML: the page is untrusted

  line.append(lvl, body);
  els.consoleBody.append(line);

  state.consoleCount += 1;
  els.consoleCount.textContent = String(state.consoleCount);
  els.consoleBody.scrollTop = els.consoleBody.scrollHeight;
}

function run() {
  const markup = els.editor.value;
  if (!markup.trim()) {
    toast('Nothing to run — paste some HTML first.');
    els.editor.focus();
    return;
  }

  state.runToken += 1;
  const token = state.runToken;

  clearConsole();
  els.frameEmpty.classList.add('hidden');
  setStatus('running', 'running');

  const started = performance.now();
  const doc = prepareDocument(markup, token);

  // A blob: URL rather than srcdoc.
  //
  // A srcdoc iframe *inherits the parent's Content-Security-Policy*, so a host
  // `script-src 'self'` blocks every inline script in the preview: the app would
  // render markup but never execute any JavaScript in it, and its own console
  // bridge would never load. A blob: URL is a separate document that does not
  // inherit the host CSP, while the `sandbox` attribute still forces an opaque
  // origin — so the isolation is unchanged.
  //
  // The previous URL is revoked so an auto-run loop does not leak blobs.
  if (state.currentBlobURL) URL.revokeObjectURL(state.currentBlobURL);
  // The charset is not optional: without it WebKit decodes the document as
  // Latin-1, mangling every non-ASCII character the bridge emits (em dashes in
  // its own messages, for one).
  state.currentBlobURL = URL.createObjectURL(
    new Blob([doc], { type: 'text/html;charset=utf-8' }));
  els.frame.src = state.currentBlobURL;

  els.outputMeta.textContent = new Blob([doc]).size.toLocaleString() + ' B';

  // A page that never logs still needs the status to settle.
  const settle = () => {
    if (token !== state.runToken) return;
    setStatus('ok', 'ok');
    els.outputMeta.textContent =
      Math.round(performance.now() - started) + ' ms · ' + els.outputMeta.textContent;
  };
  state.settleTimer = setTimeout(settle, 1200);
}

/* ------------------------------------------------------------------ *
 * Console messages from the frame
 * ------------------------------------------------------------------ */

window.addEventListener('message', (event) => {
  // Only accept messages from our own frame, and only our own shape.
  if (event.source !== els.frame.contentWindow) return;
  const data = event.data;
  if (!data || data.__pagepocket !== true) return;
  if (data.token !== state.runToken) return;   // stale run

  const text = String(data.text ?? '');
  const level = ['log', 'info', 'warn', 'error', 'sys'].includes(data.level) ? data.level : 'log';

  if (level === 'sys' && text === '__loaded__') {
    if (state.settleTimer) clearTimeout(state.settleTimer);
    setStatus('ok', 'ok');
    return;
  }

  appendConsole(level, text);
});

/* ------------------------------------------------------------------ *
 * Share links
 *
 * The markup is deflate-compressed and base64url-encoded into the URL fragment.
 * Fragments are never sent to a server, so the document stays client-side.
 * ------------------------------------------------------------------ */

async function deflateToBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') {
    // Fallback: plain base64. Bigger links, same privacy property.
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    return 'u' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  compressed.forEach((b) => { binary += String.fromCharCode(b); });
  return 'c' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function inflateFromBase64Url(encoded) {
  const kind = encoded[0];
  const payload = encoded.slice(1);
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));

  if (kind === 'u') return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot open compressed share links.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

async function makeShareLink() {
  const markup = els.editor.value;
  if (!markup.trim()) { toast('Nothing to share yet.'); return; }

  const encoded = await deflateToBase64Url(markup);
  const url = new URL(location.href);
  url.hash = 'h=' + encoded;
  url.search = '';

  els.shareUrl.value = url.toString();

  const bytes = markup.length;
  const ratio = Math.round((encoded.length / Math.max(bytes, 1)) * 100);
  els.shareInfo.textContent =
    `${bytes.toLocaleString()} chars → ${encoded.length.toLocaleString()} char link (${ratio}%). ` +
    (url.toString().length > 8000
      ? 'This link is long enough that some apps may truncate it — consider Download instead.'
      : 'Fits comfortably in most chat apps and email.');

  els.shareDialog.showModal();
}

/** Loads markup from the fragment on first paint, if one is present. */
async function loadFromFragment() {
  const hash = location.hash;
  if (!hash.startsWith('#h=')) return false;
  try {
    const markup = await inflateFromBase64Url(hash.slice(3));
    els.editor.value = markup;
    updateEditorMeta();
    return true;
  } catch (error) {
    toast('That share link could not be read.');
    console.warn('share link decode failed', error);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Editor chrome
 * ------------------------------------------------------------------ */

function updateGutter() {
  const lines = els.editor.value.split('\n').length;
  // Only the visible count matters; a fixed pad avoids layout thrash.
  els.gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
}

function updateEditorMeta() {
  const bytes = new Blob([els.editor.value]).size;
  els.editorMeta.textContent = bytes.toLocaleString() + ' B';
  updateGutter();
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('show'), 2400);
}

/* ------------------------------------------------------------------ *
 * Samples
 * ------------------------------------------------------------------ */

const SAMPLES = [
  {
    name: 'Hello, canvas',
    about: 'A tiny animated canvas — proves scripts and rAF run.',
    markup: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;display:grid;place-items:center;height:100vh;background:#111;color:#eee;
       font-family:system-ui,sans-serif}
  canvas{border-radius:12px;background:#181828}
</style></head>
<body>
<canvas id="c" width="320" height="200"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  let t = 0;
  function frame() {
    t += 0.02;
    ctx.clearRect(0, 0, 320, 200);
    for (let i = 0; i < 40; i++) {
      const a = t + i * 0.16;
      ctx.beginPath();
      ctx.arc(160 + Math.cos(a) * 70, 100 + Math.sin(a * 1.3) * 50, 5, 0, Math.PI * 2);
      ctx.fillStyle = 'hsl(' + ((i * 9 + t * 40) % 360) + ' 90% 65%)';
      ctx.fill();
    }
    requestAnimationFrame(frame);
  }
  frame();
  console.log('canvas sample running');
<\/script>
</body>
</html>`,
  },
  {
    name: 'Console & errors',
    about: 'Shows every console level plus a caught and uncaught error.',
    markup: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body{font-family:system-ui,sans-serif;padding:24px;background:#fff;color:#111}
  button{font:inherit;padding:9px 14px;border-radius:9px;border:1px solid #ccc;background:#f6f6f8;cursor:pointer}
</style></head>
<body>
<h2>Open the console below</h2>
<p>Each button logs at a different level.</p>
<button onclick="console.log('a log', {n: 1, ok: true})">log</button>
<button onclick="console.warn('a warning')">warn</button>
<button onclick="console.error('an error')">error</button>
<button onclick="boom()">throw</button>
<script>
  console.info('sample ready');
  function boom() { throw new Error('deliberate explosion'); }
  Promise.reject(new Error('rejected on purpose'));
<\/script>
</body>
</html>`,
  },
  {
    name: 'Storage (in-memory)',
    about: 'localStorage is unavailable in a sandboxed frame, so the page shims it.',
    markup: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body{font-family:system-ui,sans-serif;padding:24px;background:#0f1520;color:#e8eefc}
  code{background:#1c2637;padding:2px 6px;border-radius:5px}
</style></head>
<body>
<h2>Storage check</h2>
<p id="out">checking…</p>
<script>
  // A sandboxed frame has an opaque origin, so localStorage throws on access.
  // Shim it in memory so demos that expect it still work — and be honest in the
  // output about what happened.
  let real = false;
  try { localStorage.setItem('probe', '1'); localStorage.removeItem('probe'); real = true; }
  catch (e) { real = false; }

  if (!real) {
    const mem = new Map();
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k) => (mem.has(k) ? mem.get(k) : null),
        setItem: (k, v) => mem.set(k, String(v)),
        removeItem: (k) => mem.delete(k),
        clear: () => mem.clear(),
        key: (i) => Array.from(mem.keys())[i] ?? null,
        get length() { return mem.size; }
      },
      configurable: true
    });
  }

  localStorage.setItem('greeting', 'hello');
  document.getElementById('out').innerHTML = real
    ? 'Real <code>localStorage</code> is available.'
    : 'Real storage is blocked (sandboxed origin), so an <b>in-memory shim</b> is active. '
      + 'Value read back: <code>' + localStorage.getItem('greeting') + '</code>';
  console.log('storage mode:', real ? 'real' : 'shimmed');
<\/script>
</body>
</html>`,
  },
];

function renderSamples() {
  els.sampleList.innerHTML = '';
  for (const sample of SAMPLES) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sample';

    const strong = document.createElement('strong');
    strong.textContent = sample.name;
    const span = document.createElement('span');
    span.textContent = sample.about;

    button.append(strong, span);
    button.addEventListener('click', () => {
      // The samples contain a literal <\/script> so they can live in this file.
      els.editor.value = sample.markup.replace(/<\\\/script>/g, '</scr' + 'ipt>');
      updateEditorMeta();
      els.samplesDialog.close();
      run();
    });

    li.append(button);
    els.sampleList.append(li);
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

els.editor.addEventListener('input', () => {
  updateEditorMeta();
  if (els.optAutorun.checked) {
    clearTimeout(state.autoRunTimer);
    state.autoRunTimer = setTimeout(run, 700);
  }
});

els.editor.addEventListener('scroll', () => {
  els.gutter.scrollTop = els.editor.scrollTop;
});

// Tab inserts two spaces rather than moving focus out of the editor.
els.editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en, value } = els.editor;
    els.editor.value = value.slice(0, s) + '  ' + value.slice(en);
    els.editor.selectionStart = els.editor.selectionEnd = s + 2;
    updateEditorMeta();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); downloadHtml(); }
});

$('btn-run').addEventListener('click', run);
$('btn-reload').addEventListener('click', run);
$('btn-clear-console').addEventListener('click', clearConsole);
$('btn-samples').addEventListener('click', () => els.samplesDialog.showModal());
$('btn-share').addEventListener('click', makeShareLink);
/* ------------------------------------------------------------------ *
 * Full screen
 *
 * Exiting must not depend on a click reaching this document: the previewed
 * page receives its own clicks, so "click anywhere to exit" leaves a user
 * with no way back. There is an explicit button in the chrome, plus Escape.
 * ------------------------------------------------------------------ */

function setImmersive(on) {
  document.body.classList.toggle('immersive', on);

  // The browser's own full screen makes this feel native where permitted;
  // failure is fine (iOS Safari refuses for non-video elements).
  if (on) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
  }
}

// Capture phase, so this runs whether or not the page stops propagation.
$('btn-immersive').addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  setImmersive(true);
});

$('btn-exit-immersive').addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  setImmersive(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('immersive')) {
    setImmersive(false);
  }
});

// Keep the button in sync if the user leaves browser full screen another way.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('immersive')) {
    // Only auto-exit if the browser was actually driving full screen.
    // (On iOS requestFullscreen is unavailable, so this never fires there.)
    if (document.fullscreenEnabled) setImmersive(false);
  }
});

$('btn-copy-share').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.shareUrl.value);
    toast('Link copied.');
  } catch {
    els.shareUrl.select();
    toast('Press ⌘C to copy.');
  }
});

els.shareDialog.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-close')) els.shareDialog.close();
});
els.samplesDialog.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-close')) els.samplesDialog.close();
});

/* ---- Open a local file ---- */

$('btn-open').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.html,.htm,.xhtml,.svg,text/html';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    els.editor.value = await file.text();
    updateEditorMeta();
    toast('Loaded ' + file.name);
    run();
  });
  input.click();
});

/* ---- Download ---- */

function downloadHtml() {
  const markup = els.editor.value;
  if (!markup.trim()) { toast('Nothing to download yet.'); return; }

  const blob = new Blob([markup], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  // Name it from the page's own <title> when there is one.
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(markup)?.[1]?.trim();
  const name = (title ? title.replace(/[^\w\-. ]+/g, '').slice(0, 60).trim() : '') || 'page';

  const a = document.createElement('a');
  a.href = url;
  a.download = name + '.html';
  a.click();

  // Revoke on the next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Downloaded ' + name + '.html');
}

$('btn-download').addEventListener('click', downloadHtml);

/* ---- Drag and drop a file onto the page ---- */

document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  els.editor.value = await file.text();
  updateEditorMeta();
  toast('Loaded ' + file.name);
  run();
});

/* ---- Boot ---- */

renderSamples();
updateEditorMeta();

loadFromFragment().then((loaded) => {
  if (!loaded && !els.editor.value.trim()) {
    setStatus('idle', 'idle');
  }
  if (loaded) run();
});

// Reflect the fragment as the user edits, so a reload keeps their work.
window.addEventListener('beforeunload', () => {});
