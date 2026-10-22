# Developing dsh-run-button

This page is for people changing the plugin. To install and use it, see the [README](../README.md).

## Run from source

```bash
# junction the package into the profile's node_modules, then mount it
dsh dev inject <path-to>/dsh-run-button
```

Then restart DSH (or reload the page for the client half). The loaded bundles stay in memory, so a changed `lib/client.js` needs at least a page reload and a changed `lib/index.js` needs a DSH restart.

To install without the market or the `dsh` CLI, add the package to the profile by hand. Plain `npm install dsh-run-button` is not enough: DSH only loads a plugin that appears in the profile's `bundles` list.

```json
{
  "dependencies": { "dsh-run-button": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["...", "dsh-run-button"] } }
}
```

## How it works

Two halves, one Cordis plugin package:

```
dsh-run-button/
├── package.json          dsh.bundle.patch + dsh.client {platform:"web"}
├── cordis.patch.yml      profile row: - insert: [{id: run-button, name: dsh-run-button}]
├── lib/index.js          HOST  — ESM Cordis plugin
├── lib/client.js         CLIENT — classic-script bundle (window.__ModuleLoader__)
├── docs/DEVELOPMENT.md   this page
├── scripts/check-client.mjs       parse gate + undeclared-global audit
├── scripts/simulate-client.mjs    mounts against a real DOM and drives the whole path
├── scripts/test-host-mount.mjs    host half: mount / teardown
└── scripts/test-host-start.mjs    host half: start, Run→AI, PTY input
```

**Host half** (`lib/index.js`) mounts a dedicated loopback RPC channel, `/dsh-run-button`, with endpoints `info`, `start`, `output`, `input`, `kill`. `start` resolves the session's cwd and sandbox policy, then launches the command. When the host offers a terminal primitive (`ctx.subprocess.spawnTerminal`, DSH 0.2) it runs `bash -c <command>` on a **PTY**, confined by `ctx.sandbox.confine` unless the session is `danger-full-access`, and wraps the terminal in the same handle shape the shell seam returns (ANSI sequences stripped, CRLF folded, 1 MB retained, 30-minute ceiling). Otherwise — or if confinement/spawn fails, or the request passes `interactive: false` — it falls back to the plain `shell` service (`ctx.shell.resolve` → `ctx.shell.execute`, or `ctx.shell.start` on older hosts), where stdin is closed. `input` writes to the PTY (`{ runId, data }`) or interrupts its foreground job (`{ runId, signal: "SIGINT" }`); `info` and every view report `interactive` so the UI only shows the input row when it can work. `output` reads **incremental** deltas (`readOutput()` never repeats text) and returns a JSON-safe view: status, exit code, signal, cwd, sandbox mode, and the accumulated streams. Every side effect is a `ctx.effect`, including killing live processes on teardown.

**Client half** (`lib/client.js`) does three things:

1. A `MutationObserver` scans the transcript for `[data-code-block-banner]`, reads the language and the `<pre>` text, and appends a Run chip plus a cwd chip into the banner's action row **as trailing children** — React's reconciler never enumerates DOM children, so an extra trailing node survives re-renders. Because the transcript virtualizes above 100 records, re-scans run on mutation and on scroll.
2. A run store polls `output` every 180 ms over `connection.rpc.call` and notifies its subscribers; the React views render from that store, so the chip, the composer strip, and the workbench tab always agree.
3. Output renders in the bottom-right dock (one fixed container, one card per run), or — in `Panel` mode — in a per-run tab registered through `ctx.betterSidebar.registerTab(...)` and opened with `openTab({ target: 'right' | 'bottom' })`. The tab body is an ordinary React component receiving the standard `TabComponentProps`. Cards are deliberately not anchored to the code block: once the block scrolls out of the virtualized transcript the anchor lookup fails and the same run renders twice.

The compact run strip registers in the session Slot `conversation.input.dock`.

**Run→AI** starts the same run but also registers it with `ctx.jobs`, owned by the session's agent, so `dsh-tool-jobs` delivers a completion notice and wakes an idle agent. Without a jobs service or an owning agent it degrades to a plain run, and the start view reports why in `agentNotify`.

## No build step

Both halves are hand-written plain JavaScript:

- `lib/index.js` is ordinary ESM — the Cordis loader imports it directly (`tsconfig`/`tsdown` not required).
- `lib/client.js` is a **classic script** (not a module) in the one registration format the browser kernel accepts:

```js
window.__ModuleLoader__.load({
  id: "dsh-run-button",           // must equal the package.json name
  factory: (require) => { var module = {exports:{}}; var exports = module.exports; /* … */ return module.exports }
})
```

`require` resolves only against the shell's frozen baseline (`react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`, …), which is why this plugin needs nothing beyond `react`.

## Tests

Run these before publishing:

```bash
node scripts/check-client.mjs      # parse + materialize the factory; audits for undeclared globals
node scripts/simulate-client.mjs   # mount it against a real DOM and drive the whole path
node scripts/test-host-mount.mjs   # host half: mount, reload race, teardown
node scripts/test-host-start.mjs   # host half: execute/start, Run->AI jobs, PTY input, fallbacks
```

`npm run check` runs all of them.

`simulate-client.mjs` is the important one. It evaluates the bundle the way the shell does (`window.__ModuleLoader__`, then a Cordis-like `ctx`), mounts it over a [happy-dom](https://github.com/capricorn86/happy-dom) document, renders the real code-block markup, and then:

- asserts the Run chip was injected into the banner and clicks it;
- asserts `run/start` and `output` were actually called on the RPC channel;
- switches output mode and asserts dock cards appear, then disappear, and that exactly one dock container exists with one card per run;
- asserts the tab type is registered, does **not** dedupe, and that two runs produce **two distinct tab ids each carrying its own `runId`** — the per-run pairing, which is the thing most likely to silently regress;
- drives an interactive run: the field masks on `Password:`, survives re-renders, sends `^C` as SIGINT and Enter as `text + "\r"`, and never leaks the typed text into the card or `sessionStorage`;
- checks the one-line strip: one finished chip, older runs behind `+N`, the history menu, **Clear finished**, and icon switches with hover labels;
- unmounts and asserts nothing was left behind.

It exists because the earlier `check-client.mjs` only proved the bundle *parsed*. It did not run `apply()`, so an undeclared global (`styles`) sailed through and turned the whole page into "Failed to load plugins". Both bugs that shipped were caught by this harness **while it was being written** — which is the argument for keeping it.

## Host contracts (read before touching the client half)

`lib/client.js` is hand-written plain JS with no type checking behind it: an invented API or a missing required field does not fail the build — it becomes a white screen or a crashed sidebar tab. These contracts are taken from the host's own definitions.

### There are no ambient globals

The **dynamic** Cordis plugin sandbox hands out `styles` and `harness` as builtins. A shipped package bundle gets **neither** — referencing one throws inside `apply()`, and a throwing `apply()` takes the whole composition down ("Failed to load plugins"), not just this plugin. Every browser global is therefore reached as `window.<name>`, and `check-client.mjs` fails the build if a bare one reappears.

`apply()` is also wrapped in `try/catch`: on failure it reports, undoes whatever did mount, and returns, so this plugin can never be the reason the page stops rendering.

### Injecting CSS: there is no `styles` service

The client kernel does **not** provide a `styles` service, and `ctx.get("styles")` yields nothing. Insert a `<style>` element yourself and remove it symmetrically in teardown (`apply()` can run more than once):

```js
var tag = document.createElement("style");
tag.id = PREFIX + "-styles";
tag.textContent = CSS;          // in this repo CSS is a string (array .join("")), not an array
document.head.appendChild(tag);
```

### `ctx.betterSidebar.registerTab()`: `component` is required

`TabDescriptor` (see `dsh-better-sidebar/src/client/service.ts`):

| Field | Required | Notes |
| --- | --- | --- |
| `id` | ✅ | Unique id; also the `SidebarTab.type`. |
| `title` | ✅ | `string \| (() => string)` |
| `component` | ✅ | `(props: TabComponentProps) => ReactNode`. **Omitting it means `createElement(undefined)` → React #130.** |
| `description` | | One line in the host's new-tab list. |
| `icon` | | `ReactNode \| ((size: number) => ReactNode)` |
| `order` | | Menu sort order, default 100. |
| `hidden` | | Keep it out of the `+` menu. |
| `available` | | `(ctx, scope, state) => boolean` |
| `single` / `dedupeKey` | | Single instance / custom dedupe. |
| `createTab` | | Mint the tab and any state patch. |
| `urlTarget` | | Claim external-link clicks. |
| `settings` / `badge` | | Settings toggles / tab-strip badge. |
| `onOpen` / `onActivate` / `onClose` | | Lifecycle callbacks. |

`component` receives `TabComponentProps`: `ctx`, `store`, `scope`, `tab`, and `visible` (active **and** panel open — pause polling when false).

Function declarations hoist, so `component: RunTab` may precede `function RunTab()`.

### How a render error surfaces

`dsh-better-sidebar`'s `RenderBoundary` has two scopes: ROOT (the whole sidebar shell, `index.tsx`) and PER-TAB (one tab, `Sidebar.tsx`'s `TabContent`). Either way the strip reads `dsh-better-sidebar: <message>`. **That prefix points at a tab registered by run-button, not at the sidebar itself** — the shell and the other tabs usually stay alive.

## Configuration

Nothing needs configuring. These constants can be tuned in the source:

| Knob | Where | Default |
| --- | --- | --- |
| Poll interval | `POLL_MS` in `lib/client.js` | 180 ms |
| Simultaneous runs | `MAX_LIVE_RUNS` in `lib/index.js` | 16 |
| Per-stream output cap | `MAX_STREAM_BYTES` in `lib/index.js` | 256 KB |
| Finished-run retention | `RUN_TTL_MS` in `lib/index.js` | 10 min |
| Interactive (PTY) output retained | `MAX_TERMINAL_RETAIN_BYTES` in `lib/index.js` | 1 MB |
| Interactive run ceiling | `TERMINAL_TIMEOUT_MS` in `lib/index.js` | 30 min |
| Password-prompt pattern (auto-mask) | `SECRET_PROMPT` in `lib/client.js` | `password`, `passphrase`, `パスワード`, `密码`, … |
| Finished runs shown as chips | `VISIBLE_FINISHED` in `lib/client.js` | 1 |
| Recognised languages | `SHELL_LANGUAGES` in `lib/client.js` | see the README |
