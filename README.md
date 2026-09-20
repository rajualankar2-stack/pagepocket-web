# PagePocket Web

Paste HTML and run it instantly, in a sandboxed frame. No build step, no server, no dependencies.

The web companion to [PagePocket for iOS](https://github.com/rajualankar2-stack/PagePocket).

---

## What it does

- **Paste HTML, press Run** — the markup renders immediately
- **Console capture** — `log`/`info`/`warn`/`error`, uncaught exceptions and unhandled rejections, forwarded from the frame
- **Samples** — three working examples, including one that demonstrates the sandbox's storage behaviour
- **Share link** — the markup is deflate-compressed into the URL fragment, so the link works without a server ever seeing it
- **Download** — save the markup as an `.html` file, named from its `<title>`
- **Open file** or **drag and drop** an `.html` file in
- **Auto-run** while typing, for quick iteration
- **Full screen** output

`⌘↵` runs. `⌘S` downloads.

---

## Security model

This is the part that matters, because the app's whole job is executing HTML you got from somewhere else.

The rendered document runs in an iframe with:

```html
<iframe sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock">
```

**`allow-same-origin` is deliberately withheld.** That single omission is what makes the isolation real: without it the frame gets a unique, opaque origin (`origin === "null"`), so the document cannot read this page's DOM, cookies, `localStorage`, `IndexedDB` or session storage, and cannot navigate the top frame. Its only channel back is `postMessage`, which the parent accepts only from its own frame and only in its own message shape.

Verified against a deliberately hostile document, not assumed:

| Attack | Result |
|---|---|
| `parent.document.title` | `SecurityError` |
| `document.cookie` | `SecurityError` |
| `localStorage.setItem` | `SecurityError` |
| `location.origin` | `"null"` (opaque) |
| `top.location = 'https://evil.example'` | `SecurityError` |

Those assertions run in the test suite (`test/test.mjs`), so a regression fails the build rather than shipping.

### What the sandbox does *not* do

It does not stop the document from making network requests. A sandboxed frame can still `fetch('https://example.com')`, load a remote image, or send a form — `allow-forms` is needed for ordinary pages, and CSP does not apply to a `srcdoc` frame's own requests. **If you paste HTML you do not trust, it can phone home.** Treat the sandbox as protecting *this page and your data* from the document, not as protecting the network from the document.

The app never sends your markup anywhere. It is not uploaded, not stored remotely, and not logged. The share feature encodes it into the URL fragment, which browsers do not transmit to servers — that is why sharing works with no backend at all.

---

## Running it

Any static file server works. There is nothing to build.

```bash
python3 -m http.server 8899
# open http://127.0.0.1:8899/
```

A server is required rather than opening `index.html` directly, because the app uses ES modules.

## Testing

```bash
npm install -D playwright && npx playwright install chromium
node test/test.mjs
```

24 checks covering the sandbox attribute, hostile-document isolation, console
capture, rendering, fragment wrapping, the share round-trip, and that no external
requests are made.

It runs against `test/csp-server.mjs`, which serves the app with the CSP **read
from `vercel.json`** — not a plain static server. That matters: a CSP-free server
hides the app's worst failure mode, where the preview inherits a policy that
blocks every pasted script. That bug shipped once. Two of the checks now assert
inline scripts execute and that the served policy matches the config, so it
cannot ship again.

```bash
node test/csp-server.mjs &
node test/test.mjs
```

Point it at a deployment to check the live site:

```bash
BASE_URL=https://pagepocket-web.vercel.app/ node test/test.mjs
```

---

## Deploying to Vercel

This project is set up to deploy under the **same Vercel team** as the other
projects on this machine (`team_cYwhvlK1rtXWMKQFA3B7WYUd` — the one
`Yuvaplannextech` uses), so it sits alongside them rather than under a personal
scope.

### One command

```bash
./deploy.sh
```

It checks the CLI is installed, runs `vercel login` if you are not signed in
(the browser step is the only part that cannot be automated), links the project
to the right team, and deploys to production.

### Or manually

```bash
vercel login
vercel link --project pagepocket-web --scope team_cYwhvlK1rtXWMKQFA3B7WYUd
vercel deploy --prod --scope team_cYwhvlK1rtXWMKQFA3B7WYUd
```

### Or with no CLI at all

Import the repo from the dashboard and pick the same team:

<https://vercel.com/new/clone?repository-url=https://github.com/rajualankar2-stack/pagepocket-web>

There is no build step — Vercel serves the static files as-is.

### Security headers

`vercel.json` adds the headers Vercel does not set by default:

- `Content-Security-Policy` — `default-src 'self'`, no remote scripts, `connect-src 'self'`.
  `script-src` includes `'unsafe-inline'`, which is **required, not optional**: the
  previewed document inherits this policy, and pasted HTML is overwhelmingly inline
  `<script>`. Without it the app renders markup and executes none of its JavaScript.
  Verified that no frame delivery mechanism (`srcdoc`, `blob:`, `data:`) avoids this.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `X-Frame-Options: DENY` — this app is not embeddable
- `Permissions-Policy` — geolocation, microphone, camera, payment and USB all denied
- `Cross-Origin-Opener-Policy: same-origin`

The app has no server-side component, so it deploys as pure static files.

Note the host CSP applies to *this* app's own pages. It does not constrain the
sandboxed preview frame, which is governed by the `sandbox` attribute instead —
see the security model above.

---

## Structure

```
index.html        markup and the sandboxed iframe
css/app.css       styling
js/app.js         editor, runner, console bridge, share encoding, samples
test/test.mjs     Playwright suite
deploy.sh         one-command deploy to the right Vercel team
vercel.json       static hosting + security headers
```

No frameworks and no runtime dependencies — the whole app is about 600 lines of vanilla JS.

## License

MIT
