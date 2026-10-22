/**
 * dsh-run-button — Host half.
 *
 * Owns command execution for the "Run" button the browser half injects into
 * shell code blocks. Execution deliberately does *not* go through a private
 * HTTP route of its own: the shipped `shell` service already gives us a
 * background process handle with incremental output reads, so the client drives
 * a short poll loop over the plugin's own Connection RPC channel
 * (`/dsh-run-button`) and every side effect stays owned by this Cordis fiber.
 *
 * Security posture: a run inherits the calling Session's own sandbox policy
 * (`ctx.sandboxPolicy.resolve`) and its workspace cwd, so pressing the button
 * can never reach further than the Agent working in that Session could. The
 * command is executed exactly as authored in the block; nothing is interpolated.
 */

/** Per-stream cap before a run's output is dropped and marked truncated. */
const MAX_STREAM_BYTES = 256 * 1024
/** Guard against a runaway number of concurrent button-driven processes. */
const MAX_LIVE_RUNS = 16
/** Finished runs stay readable for this long before the map forgets them. */
const RUN_TTL_MS = 10 * 60 * 1000
/** Largest request body this channel buffers; run payloads are tiny. */
const MAX_REQUEST_BYTES = 1 << 20

/**
 * Interactive (PTY) runs keep at most this many bytes of terminal output for
 * the Run→AI job reader; older bytes are dropped and the read marked lossy.
 */
const MAX_TERMINAL_RETAIN_BYTES = 1024 * 1024
/**
 * Hard ceiling for one interactive run. The pipe executor applies its own
 * 120s default timeout; a PTY run may legitimately sit at a prompt while the
 * user types, so it gets a longer, explicit bound instead of none at all.
 */
const TERMINAL_TIMEOUT_MS = 30 * 60 * 1000
/** Fixed viewport handed to the PTY; output is shown as plain wrapped text. */
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 40
/** TERM→KILL grace the PTY provider applies when a run is stopped. */
const TERMINAL_GRACE_MS = 3000
/**
 * Child environment for interactive runs. Mirrors the pipe executor's
 * overrides so programs stay plain-text, while still being a real terminal.
 */
const TERMINAL_ENV = { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', HOMEBREW_NO_COLOR: '1', HOMEBREW_NO_EMOJI: '1' }

/**
 * Turn raw terminal bytes into the plain text the panel and the job reader
 * show: drop ANSI CSI/OSC/charset sequences and other C0 controls, fold CRLF to
 * LF, and keep bare CR (a progress redraw) for the client to collapse.
 * Stateful because a sequence or a CRLF may be split across two chunks.
 */
const createTerminalSanitizer = () => {
  let carry = ''
  return (chunk, final = false) => {
    let text = carry + chunk
    carry = ''
    if (!final) {
      // Hold back an unfinished escape sequence or a trailing CR.
      const esc = text.lastIndexOf('\u001b')
      if (esc !== -1 && !/^\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-~]|[@-Z\\^_])/.test(text.slice(esc))) {
        if (text.length - esc < 256) {
          carry = text.slice(esc)
          text = text.slice(0, esc)
        }
      } else if (text.endsWith('\r')) {
        carry = '\r'
        text = text.slice(0, -1)
      }
    }
    let plain = text
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b[()][0-~]/g, '')
      .replace(/\u001b[@-Z\\^_]/g, '')
      .replace(/\r+\n/g, '\n')
      .replace(/[\u0000-\u0007\u000b\u000c\u000e-\u001f\u007f]/g, '')
    // Backspace erases the character before it on screen (e.g. the "^D" echo).
    while (/[^\n\u0008]\u0008/.test(plain)) plain = plain.replace(/[^\n\u0008]\u0008/g, '')
    return plain.replace(/\u0008/g, '')
  }
}

/**
 * Wrap a `ctx.subprocess.spawnTerminal` handle in the same shape the shell
 * seam's ShellProcess has (status / exitCode / signal / done / readOutput /
 * observed / kill), plus `writeStdin` and `interrupt` for the input endpoint.
 * The PTY merges stdout and stderr, so everything lands on `stdout`.
 *
 * Input written here is never stored or logged: the only copy that reaches the
 * output is whatever the terminal itself echoes, and a password prompt turns
 * echo off.
 */
const adaptTerminal = (terminal, { timeoutMs = TERMINAL_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) => {
  const sanitize = createTerminalSanitizer()
  /** Retained sanitized output as UTF-8 chunks, plus the byte offset of chunk 0. */
  let chunks = []
  let base = 0
  let total = 0
  let uiOffset = 0
  let dropped = false

  const push = (text) => {
    if (text === '') return
    const buf = Buffer.from(text, 'utf8')
    chunks.push(buf)
    total += buf.length
    let retained = total - base
    while (retained > MAX_TERMINAL_RETAIN_BYTES && chunks.length > 1) {
      const first = chunks.shift()
      base += first.length
      retained -= first.length
      dropped = true
    }
  }

  const readFrom = (fromByte) => {
    const from = Math.max(0, Number.isFinite(fromByte) ? fromByte : 0)
    const lossy = from < base
    let offset = base
    const parts = []
    for (const buf of chunks) {
      const end = offset + buf.length
      if (end > from) parts.push(from > offset ? buf.subarray(from - offset) : buf)
      offset = end
    }
    return { text: Buffer.concat(parts).toString('utf8'), nextOffset: total, lossy }
  }

  const handle = {
    interactive: true,
    status: 'running',
    exitCode: null,
    signal: null,
    error: undefined,
    killed: false,
    done: undefined,
    observed: {
      stdout: { readFrom },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    readOutput() {
      const read = readFrom(uiOffset)
      uiOffset = read.nextOffset
      const lossy = read.lossy || dropped
      dropped = false
      return { delta: read.text, lossy }
    },
    kill() {
      if (handle.status !== 'running') return false
      handle.killed = true
      terminal.terminate().catch(() => {})
      return true
    },
    async writeStdin(data) {
      if (handle.status !== 'running') throw new Error('the command has already finished')
      await terminal.write(data)
    },
    /** Ctrl-C: SIGINT to the foreground job, or the ^C byte if that cannot be resolved. */
    async interrupt() {
      if (handle.status !== 'running') throw new Error('the command has already finished')
      try {
        await terminal.signalForeground('SIGINT')
      } catch (error) {
        await terminal.write('\u0003')
      }
    },
  }

  const decoder = new TextDecoder('utf-8')
  const output = terminal.output
  const drained = new Promise((resolve) => {
    if (output === undefined || output === null) {
      resolve()
      return
    }
    output.on('data', (data) => {
      push(sanitize(typeof data === 'string' ? data : decoder.decode(data, { stream: true })))
    })
    output.once('end', resolve)
    output.once('close', resolve)
    output.once('error', resolve)
  })

  const timer = setTimer(() => {
    if (handle.status !== 'running') return
    handle.error = `stopped after ${Math.round(timeoutMs / 60000)} minutes (interactive run limit)`
    handle.kill()
  }, timeoutMs)
  timer?.unref?.()

  handle.done = Promise.resolve(terminal.done)
    .then(
      (outcome) => ({ exitCode: outcome?.exitCode ?? null, signal: outcome?.signal ?? null }),
      (error) => {
        handle.error = `terminal failed: ${String(error?.message ?? error)}`
        return { exitCode: null, signal: null }
      },
    )
    .then(async (outcome) => {
      // Let the last bytes arrive, but never hang on a stream that won't end.
      await Promise.race([drained, new Promise((resolve) => setTimer(resolve, 500))])
      push(sanitize(decoder.decode(), true))
      clearTimer(timer)
      handle.exitCode = outcome.exitCode
      handle.signal = outcome.signal
      handle.status = handle.killed ? 'killed' : 'completed'
    })
  return handle
}

/** Dedicated loopback-only RPC channel registered by this Host half. */
const CHANNEL = '/dsh-run-button'
/** Endpoints accepted on {@link CHANNEL}. */
const ENDPOINTS = ['info', 'start', 'output', 'input', 'kill']
/** Envelope discriminators the browser caller and this host agree on. */
const CLIENT_REQUEST = 'client-request'
const SERVER_RESPONSE = 'server-response'
/** Endpoint segment shape accepted by the Connection router, mirrored here. */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/

export const name = 'dsh-run-button'
// `timer` is a hard dependency: the mount retry below uses ctx.interval(), and
// cordis refuses an undeclared service with
// 'cannot get property "interval" without inject'.
export const inject = ['shell', 'timer']
// `jobs` and `agents` are optional: without them "Run -> AI" degrades to a plain run.

/**
 * Register the run-button RPC surface on the Host.
 * @param ctx - owning Cordis context; every handler is disposed with this fiber.
 */
export function apply(ctx) {
  /** @type {Map<string, object>} live and recently finished runs, keyed by runId. */
  const runs = new Map()

  /**
   * Mount diagnostics.
   *
   * The RPC route once failed to mount and the only symptom was a 405 from the
   * SPA fallback — which is nearly impossible to read backwards, because an
   * unowned path is answered by the frontend-static fallback, whose method check
   * rejects a POST. One summary line plus explicit failure reasons turn that
   * into a directly readable log.
   */
  const note = (message) => {
    try {
      console.log(`[dsh-run-button] ${message}`)
    } catch (error) {
      /* logging must never break the plugin */
    }
  }
  note(`host half applying; channel=${CHANNEL}`)
  note(`webServer=${ctx.get('webServer') !== undefined} connection=${ctx.get('connection') !== undefined} shell=${ctx.get('shell') !== undefined}`)

  let counter = 0
  const nextId = () => {
    counter += 1
    return `rb-${Date.now().toString(36)}-${counter.toString(36)}`
  }

  const stringOrUndefined = (value) =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined

  /**
   * Find the live Agent whose Session id matches, so the run inherits its cwd
   * and sandbox mode.
   *
   * This lookup decides whether a command can run at all. With no session the
   * run falls back to the deployment default, and on a host whose confined
   * backend is unusable (the Windows ACL runner refuses when its temp root sits
   * inside the workspace) every such run fails. So when the client's session
   * cannot be resolved and exactly ONE agent is live, that agent is used: it is
   * the only session this process can be serving, and its policy is precisely
   * what that session's own tools would run under.
   *
   * @returns the agent (or undefined) and why, for the mount log.
   */
  const findAgent = (sessionId) => {
    const agents = ctx.get('agents')
    if (agents === undefined) return { agent: undefined, reason: 'no agents service' }
    let list
    try {
      list = agents.list()
    } catch (error) {
      return { agent: undefined, reason: `agents.list() failed: ${String(error)}` }
    }
    if (sessionId !== undefined) {
      for (const agent of list) {
        if (String(agent.id) === sessionId) return { agent, reason: `matched ${sessionId}` }
      }
    }
    if (list.length === 1) {
      return {
        agent: list[0],
        reason: sessionId === undefined
          ? 'no sessionId sent; using the only live session'
          : `sessionId ${sessionId} matched nothing; using the only live session ${String(list[0].id)}`,
      }
    }
    return { agent: undefined, reason: `no session resolved (${list.length} live agents)` }
  }

  /** Session cwd first, then the client's report, then the policy workspace root. */
  const resolveWorkdir = (agent, requested) => {
    let sessionCwd
    try {
      sessionCwd = agent?.session?.header?.cwd
    } catch (error) {
      sessionCwd = undefined
    }
    if (typeof sessionCwd === 'string' && sessionCwd !== '') return sessionCwd
    const wanted = stringOrUndefined(requested)
    if (wanted !== undefined) return wanted
    const policy = ctx.get('sandboxPolicy')
    if (policy !== undefined && typeof policy.workspaceRoot === 'string') return policy.workspaceRoot
    return undefined
  }

  /** Confine the run exactly as the Session's own tools would be confined. */
  const resolveSandboxPolicy = (agent) => {
    const policy = ctx.get('sandboxPolicy')
    if (policy === undefined) return undefined
    try {
      return policy.resolve(agent === undefined ? {} : { session: agent.session })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-run-button: sandbox policy resolve failed: ${String(error)}`)
      return undefined
    }
  }

  const append = (entry, stream, text) => {
    if (text === '') return
    const target = stream === 'stderr' ? entry.stderr : entry.stdout
    if (target.truncated) return
    target.chunks.push(text)
    target.bytes += text.length
    if (target.bytes > MAX_STREAM_BYTES) {
      target.truncated = true
      target.chunks = []
    }
    entry.updatedAt = Date.now()
  }

  const reap = () => {
    const now = Date.now()
    for (const [id, entry] of runs) {
      if (entry.process.status === 'running') continue
      if (now - entry.updatedAt > RUN_TTL_MS) runs.delete(id)
    }
  }

  /** Read every unread delta from the live process into the entry's buffers. */
  const pump = (entry) => {
    let read
    try {
      read = entry.process.readOutput()
    } catch (error) {
      entry.error = `output read failed: ${String(error)}`
      return
    }
    if (read === undefined || read === null) return
    append(entry, 'stdout', typeof read.delta === 'string' ? read.delta : '')
    if (read.lossy === true) entry.lossy = true
  }

  /** Public, JSON-safe view of one run: only scalars and already-read strings. */
  const view = (entry) => {
    const handle = entry.process
    const status = handle.status
    return {
      runId: entry.runId,
      command: entry.command,
      status,
      exitCode: status === 'running' ? null : (handle.exitCode ?? null),
      signal: status === 'running' ? null : (handle.signal ?? null),
      cwd: entry.cwd ?? null,
      sandboxMode: entry.sandboxMode ?? null,
      lossy: entry.lossy === true,
      stdout: entry.stdout.chunks.join(''),
      stderr: entry.stderr.chunks.join(''),
      stdoutTruncated: entry.stdout.truncated,
      stderrTruncated: entry.stderr.truncated,
      error: entry.error ?? handle.error ?? null,
      interactive: handle.interactive === true,
      agentNotify: entry.notify ?? null,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt ?? null,
    }
  }

  /**
   * Register an already-running process with `ctx.jobs` so its completion
   * notifies (and, if idle, wakes) the owning agent.
   * @returns 'registered', or a short reason it could not be (never throws).
   */
  const registerJob = (entry, handle, agent) => {
    const jobs = ctx.get('jobs')
    if (jobs === undefined || typeof jobs.start !== 'function') return 'jobs service unavailable'
    const owner = agent?.id
    if (owner === undefined) return 'no owning agent session'
    try {
      const source = (channel) => ({
        channel,
        read: (fromByte) => handle.observed[channel].readFrom(fromByte),
      })
      jobs.start({
        kind: 'run-button',
        label: `[user ran this command with the Run button] ${entry.command}`,
        owner,
        output: [source('stdout'), source('stderr')],
        run: () => ({
          cancel: () => {
            try {
              handle.kill()
            } catch (error) {
              /* already gone */
            }
          },
          done: handle.done.then(() => (
            handle.status === 'killed'
              ? { status: 'killed', detail: handle.signal !== null ? `signal: ${handle.signal}` : 'killed before exit' }
              : { status: 'completed', detail: `exit code: ${handle.exitCode ?? 0}` }
          )),
        }),
      })
      return 'registered'
    } catch (error) {
      ctx.logger?.warn?.(`dsh-run-button: job registration failed: ${String(error)}`)
      return `job registration failed: ${String(error?.message ?? error)}`
    }
  }

  /**
   * The PTY provider, when this host has one. Plugins may read it through
   * ctx.get without declaring it; the session agent's context is a fallback for
   * compositions that only expose it inside the execution world.
   */
  const terminalProvider = (agent) => {
    if (process.platform === 'win32') return undefined
    for (const source of [ctx, agent?.ctx]) {
      try {
        const subprocess = source?.get?.('subprocess')
        if (subprocess !== undefined && typeof subprocess.spawnTerminal === 'function') return subprocess
      } catch (error) {
        /* not visible from this context */
      }
    }
    return undefined
  }

  const sandboxProvider = (agent) => {
    for (const source of [ctx, agent?.ctx]) {
      try {
        const sandbox = source?.get?.('sandbox')
        if (sandbox !== undefined && typeof sandbox.confine === 'function') return sandbox
      } catch (error) {
        /* not visible from this context */
      }
    }
    return undefined
  }

  /**
   * Start the command on a real pseudo-terminal so prompts (read, sudo, ssh)
   * can be answered through the input endpoint. Confinement mirrors
   * dsh-terminal-bash: danger-full-access runs the argv as-is, every other mode
   * goes through ctx.sandbox.confine with the session's own policy.
   * @returns the adapted handle, or undefined when a PTY is not possible here
   *   (the caller then falls back to the pipe executor).
   */
  const startTerminal = async (agent, spec) => {
    const subprocess = terminalProvider(agent)
    if (subprocess === undefined) return { handle: undefined, reason: 'no PTY provider' }
    const policy = spec.sandboxPolicy
    let argv = ['bash', '-c', spec.command]
    if (policy !== undefined && policy.mode !== 'danger-full-access') {
      const sandbox = sandboxProvider(agent)
      if (sandbox === undefined) return { handle: undefined, reason: `sandbox mode ${policy.mode} but no ctx.sandbox` }
      try {
        argv = (await sandbox.confine(argv, { ...policy, mode: policy.mode })).argv
      } catch (error) {
        return { handle: undefined, reason: `sandbox confine failed: ${String(error?.message ?? error)}` }
      }
      if (!Array.isArray(argv) || argv.length === 0) return { handle: undefined, reason: 'sandbox returned empty argv' }
    }
    let terminal
    try {
      terminal = await subprocess.spawnTerminal({
        argv,
        cwd: spec.workdir ?? process.cwd(),
        env: { ...TERMINAL_ENV, ...(spec.env ?? {}), ...(spec.dshEnv ?? {}) },
        rows: TERMINAL_ROWS,
        cols: TERMINAL_COLS,
        terminalType: 'dumb',
        graceMs: TERMINAL_GRACE_MS,
      })
    } catch (error) {
      return { handle: undefined, reason: `spawnTerminal failed: ${String(error?.message ?? error)}` }
    }
    return { handle: adaptTerminal(terminal), reason: 'pty' }
  }

  const entryFor = (args) => runs.get(stringOrUndefined(args?.runId) ?? '')

  /** @type {Record<string, (args: any) => unknown>} */
  const handlers = {
    info() {
      const policy = ctx.get('sandboxPolicy')
      return {
        platform: process.platform,
        sandboxMode: policy !== undefined ? policy.defaultMode : null,
        workspaceRoot: policy !== undefined ? policy.workspaceRoot : null,
        shells: ['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'pwsh', 'cmd', 'bat'],
        interactive: terminalProvider(undefined) !== undefined,
      }
    },

    async start(args) {
      reap()
      const command = stringOrUndefined(args?.command)
      if (command === undefined) throw new Error('empty command')
      let live = 0
      for (const entry of runs.values()) if (entry.process.status === 'running') live += 1
      if (live >= MAX_LIVE_RUNS) throw new Error(`too many running commands (limit ${MAX_LIVE_RUNS})`)

      const sessionId = stringOrUndefined(args?.sessionId)
      const lookup = findAgent(sessionId)
      const agent = lookup.agent
      const workdir = resolveWorkdir(agent, args?.cwd)
      const sandboxPolicy = resolveSandboxPolicy(agent)
      note(`start: ${lookup.reason}; workdir=${workdir ?? '(executor default)'} sandbox=${sandboxPolicy?.mode ?? '(executor default)'}`)

      const spec = ctx.shell.resolve({
        command,
        ...(workdir !== undefined ? { workdir } : {}),
        ...(sandboxPolicy !== undefined ? { sandboxPolicy } : {}),
      })
      // Prefer a PTY so the user can answer prompts. Without one (older host,
      // Windows, no sandbox provider for a confined mode) fall back to the pipe
      // executor: DSH 0.2 replaced `ctx.shell.start(spec)` with `execute(spec)`,
      // which resolves with the same ShellProcess handle
      // (readOutput/kill/done/status); `start` keeps older hosts working.
      let handle
      if (args?.interactive !== false) {
        const pty = await startTerminal(agent, spec)
        note(`start: mode=${pty.handle !== undefined ? 'pty' : `pipe (${pty.reason})`}`)
        handle = pty.handle
      }
      if (handle === undefined) {
        handle = typeof ctx.shell.execute === 'function'
          ? await ctx.shell.execute(spec)
          : ctx.shell.start(spec)
      }

      const entry = {
        runId: nextId(),
        command,
        language: stringOrUndefined(args?.language),
        sessionId,
        cwd: spec.workdir,
        sandboxMode: spec.sandboxPolicy?.mode,
        process: handle,
        stdout: { chunks: [], bytes: 0, truncated: false },
        stderr: { chunks: [], bytes: 0, truncated: false },
        lossy: false,
        error: undefined,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        finishedAt: undefined,
      }
      runs.set(entry.runId, entry)

      // "Run -> AI": also register the SAME process with the job runtime, owned
      // by the session's agent. When it settles, dsh-tool-jobs delivers the
      // completion notice and wakes an idle agent, which then reads the output
      // with job_output. Opt-in per press; a plain Run never wakes the agent.
      if (args?.notifyAgent === true) {
        entry.notify = registerJob(entry, handle, agent)
      }

      handle.done.then(
        () => {
          pump(entry)
          entry.finishedAt = Date.now()
          entry.updatedAt = entry.finishedAt
          reap()
        },
        (error) => {
          entry.error = `command failed: ${String(error)}`
          entry.finishedAt = Date.now()
          entry.updatedAt = entry.finishedAt
        },
      )

      return view(entry)
    },

    output(args) {
      const entry = entryFor(args)
      if (entry === undefined) throw new Error('unknown run')
      pump(entry)
      reap()
      return view(entry)
    },

    /**
     * Feed a running interactive run: `data` is written to the terminal as-is
     * (the client sends `text + "\r"`, `"\u0004"` for EOF), `signal: "SIGINT"`
     * interrupts the foreground job. The payload is never logged or kept.
     */
    async input(args) {
      const entry = entryFor(args)
      if (entry === undefined) throw new Error('unknown run')
      if (entry.process.status !== 'running') throw new Error('the command has already finished')
      if (args?.signal === 'SIGINT') {
        if (typeof entry.process.interrupt !== 'function') throw new Error('this run cannot be interrupted; use Stop')
        await entry.process.interrupt()
        return { accepted: true }
      }
      if (args?.signal !== undefined) throw new Error(`unsupported signal ${String(args.signal)}`)
      const writeStdin = entry.process.writeStdin
      if (typeof writeStdin !== 'function') throw new Error('this run was not started on a terminal and does not accept input')
      const data = typeof args?.data === 'string' ? args.data : ''
      if (data.length > 64 * 1024) throw new Error('input too long')
      await writeStdin.call(entry.process, data)
      entry.updatedAt = Date.now()
      return { accepted: true }
    },

    kill(args) {
      const entry = entryFor(args)
      if (entry === undefined) throw new Error('unknown run')
      if (entry.process.status !== 'running') return { killed: false }
      return { killed: entry.process.kill() === true }
    },
  }

  /** Dispatch one endpoint, mapping failures onto the channel's result union. */
  const dispatch = async (endpoint, payload) => {
    const handler = Object.prototype.hasOwnProperty.call(handlers, endpoint) ? handlers[endpoint] : undefined
    if (handler === undefined) {
      return { ok: false, error: { code: 'bad-request', message: `unknown endpoint ${endpoint}`, details: {} } }
    }
    try {
      return { ok: true, value: await handler(payload ?? {}) }
    } catch (error) {
      return { ok: false, error: { code: 'run-failed', message: String(error?.message ?? error), details: {} } }
    }
  }

  /* -------------------------------------------------------------------- *
   * Channel mounting: prefer the Connection's own RPC service (it carries
   * the kernel's channel policy), fall back to a directly registered route
   * behind the connection trust fence.
   * -------------------------------------------------------------------- */

  const connection = ctx.get('connection')

  const mountViaService = () => {
    if (connection === undefined) {
      note('mount: no connection service')
      return undefined
    }
    const rpc = connection.rpc
    if (rpc === undefined || typeof rpc.handle !== 'function') {
      note(`mount: connection.rpc.handle is ${rpc === undefined ? 'missing' : typeof rpc.handle}`)
      return undefined
    }
    try {
      const release = rpc.handle(CHANNEL, dispatch, { authority: 'loopback' })
      if (typeof release !== 'function') {
        note(`mount: rpc.handle returned ${typeof release}, not a disposer`)
        return undefined
      }
      note('mount: via connection.rpc.handle')
      return release
    } catch (error) {
      note(`mount: rpc.handle threw: ${String(error)}`)
      return undefined
    }
  }

  const readBody = async (req) => {
    const chunks = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += chunk.length
      if (bytes > MAX_REQUEST_BYTES) return { kind: 'too-large' }
      chunks.push(chunk)
    }
    try {
      return { kind: 'ok', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch (error) {
      return { kind: 'invalid' }
    }
  }

  const writeReply = (res, rpcId, result) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: SERVER_RESPONSE, rpcId, result }))
  }

  const answer = async (req, res, handler) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    if (!pathname.startsWith(`${CHANNEL}/`)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const endpoint = pathname.slice(CHANNEL.length + 1)
    if (
      req.method !== 'POST' ||
      endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT.test(segment))
    ) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    if ((req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      res.writeHead(415)
      res.end('content type must be application/json')
      return
    }
    const body = await readBody(req)
    if (body.kind === 'too-large') {
      res.writeHead(413)
      res.end('request body too large')
      return
    }
    if (body.kind === 'invalid') {
      res.writeHead(400)
      res.end('body is not JSON')
      return
    }
    const value = body.value
    const rpcId = typeof value?.rpcId === 'string' ? value.rpcId : 'invalid-request'
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value.type !== CLIENT_REQUEST) {
      writeReply(res, rpcId, {
        ok: false,
        error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} },
      })
      return
    }
    if (value.method !== endpoint) {
      writeReply(res, rpcId, {
        ok: false,
        error: {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(value.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: {},
        },
      })
      return
    }
    try {
      writeReply(res, rpcId, await handler(endpoint, value.payload))
    } catch (error) {
      res.writeHead(500)
      res.end(`handler failure: ${String(error)}`)
    }
  }

  const mountDirectRoute = () => {
    const webServer = ctx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') {
      note('mount: webServer unavailable, run buttons cannot reach the host')
      return undefined
    }
    const reject = connection?.requestRejection
    note(`mount: registering direct route; requestRejection=${typeof reject}`)
    try {
      const release = webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: async (req, res) => {
          if (typeof reject === 'function') {
            const rejection = reject.call(connection, req)
            if (rejection !== undefined) {
              res.writeHead(rejection)
              res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
              return
            }
          }
          await answer(req, res, dispatch)
        },
      })
      note(`mount: direct route registered; disposer=${typeof release}`)
      return release
    } catch (error) {
      note(`mount: direct route registration threw: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Mount the RPC surface, retrying while the path is still held.
   *
   * `webServer.register` throws on a duplicate path and its disposer deletes BY
   * PATH, so a composition reload can lose the route permanently:
   *
   *   1. the new fiber registers  -> throws, because the old fiber still holds it
   *   2. this catch swallows the throw, so the new fiber contributes nothing
   *   3. the old fiber disposes   -> deletes the path, which now nobody owns
   *
   * The only symptom is a 405 from the SPA fallback on every run, which is why
   * this retry exists rather than a one-shot mount: a few seconds of patience
   * beats a silently dead feature.
   */
  const mountOnce = () => mountViaService() ?? mountDirectRoute()

  let release = mountOnce()
  /** Disposer for the retry interval while the mount is still pending. */
  let pendingMount = null
  if (typeof release === 'function') {
    note('mount: outcome=function')
  } else {
    note('mount: not mounted yet; retrying (a reload may still hold the path)')
    let attempts = 0
    const retry = ctx.interval(() => {
      attempts += 1
      const released = mountOnce()
      if (typeof released === 'function') {
        release = released
        note(`mount: registered on retry #${attempts}`)
        retry()
        pendingMount = null
        return
      }
      if (attempts >= 30) {
        note('mount: gave up after 30 attempts; the run button cannot reach the host')
        retry()
        pendingMount = null
      }
    }, 1000)
    pendingMount = retry
  }

  ctx.effect(() => () => {
    if (pendingMount !== null) pendingMount()
    if (typeof release === 'function') release()
  }, 'dsh-run-button: RPC channel')

  // A stopping or updated Package must never leave an orphaned process behind.
  ctx.effect(
    () => () => {
      for (const entry of runs.values()) {
        try {
          if (entry.process.status === 'running') entry.process.kill()
        } catch (error) {
          /* the executor is already gone; nothing left to stop */
        }
      }
      runs.clear()
    },
    'dsh-run-button: process cleanup',
  )
}
