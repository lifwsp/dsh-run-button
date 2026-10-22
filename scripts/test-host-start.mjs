/**
 * Host-half `start` test.
 *
 * DSH 0.2 removed `ctx.shell.start(spec)` in favour of `execute(spec)`, which
 * resolves (asynchronously) with the same ShellProcess handle. This test drives
 * the real `start` endpoint through the registered RPC route against both shell
 * shapes, and checks that failures come back with the `details` object the
 * Connection client requires of every server-response error.
 *
 *   node scripts/test-host-start.mjs
 */
import { apply } from '../lib/index.js'

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

/** A finished ShellProcess-shaped handle. */
function makeHandle() {
  let read = false
  return {
    status: 'completed',
    exitCode: 0,
    signal: null,
    done: Promise.resolve(),
    readOutput() {
      if (read) return { delta: '', lossy: false }
      read = true
      return { delta: 'hello\n', lossy: false }
    },
    kill: () => false,
  }
}

const spec = (request) => ({ ...request, workdir: request.workdir ?? '/tmp' })

function createCtx(shell) {
  const services = { shell, webServer: undefined }
  return {
    routes: new Map(),
    get(name) {
      return Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined
    },
    effect() {
      return () => {}
    },
    interval: () => () => {},
    on: () => () => {},
    shell,
  }
}

/** Mount through a fake `connection.rpc.handle`, returning the dispatcher. */
function mount(shell) {
  let dispatch
  const ctx = createCtx(shell)
  const services = {
    shell,
    connection: {
      rpc: {
        handle(_channel, handler) {
          dispatch = handler
          return () => {}
        },
      },
    },
  }
  ctx.get = (name) => (Object.prototype.hasOwnProperty.call(services, name) ? services[name] : undefined)
  const originalLog = console.log
  console.log = () => {}
  apply(ctx)
  console.log = originalLog
  if (dispatch === undefined) fail('the RPC dispatcher was never registered')
  return dispatch
}

/** Every error the client parses must carry `details` as a record. */
function assertWireError(result, label) {
  const error = result?.error
  if (result?.ok !== false || typeof error?.code !== 'string' || typeof error?.message !== 'string') {
    fail(`${label}: expected a failure result, got ${JSON.stringify(result)}`)
  }
  if (error.details === null || typeof error.details !== 'object' || Array.isArray(error.details)) {
    fail(`${label}: error.details must be an object (the client rejects the envelope otherwise)`)
  }
}

/* 1. DSH 0.2 shape: only resolve + execute (async) --------------------------- */
{
  const dispatch = mount({ resolve: spec, execute: async () => makeHandle() })
  const started = await dispatch('start', { command: 'echo hello' })
  if (!started.ok) fail(`execute path: start failed: ${JSON.stringify(started)}`)
  if (started.value.stdout !== 'hello\n' && started.value.stdout !== '') fail('execute path: unexpected stdout')
  const out = await dispatch('output', { runId: started.value.runId })
  if (!out.ok || out.value.stdout !== 'hello\n') fail(`execute path: output was ${JSON.stringify(out)}`)
  console.log('OK  start works against the DSH 0.2 shell (execute)')
}

/* 2. Older shape: resolve + start (sync) ------------------------------------- */
{
  const dispatch = mount({ resolve: spec, start: () => makeHandle() })
  const started = await dispatch('start', { command: 'echo hello' })
  if (!started.ok) fail(`legacy path: start failed: ${JSON.stringify(started)}`)
  console.log('OK  start still works against the older shell (start)')
}

/* 3. Failures keep the wire contract ----------------------------------------- */
{
  const dispatch = mount({ resolve: spec, execute: async () => makeHandle() })
  assertWireError(await dispatch('start', {}), 'empty command')
  assertWireError(await dispatch('nope', {}), 'unknown endpoint')
  assertWireError(await dispatch('output', { runId: 'missing' }), 'unknown run')

  const broken = mount({
    resolve: spec,
    execute: async () => {
      throw new Error('spawn exploded')
    },
  })
  const result = await broken('start', { command: 'echo hi' })
  assertWireError(result, 'execute rejects')
  if (!String(result.error.message).includes('spawn exploded')) fail('the real failure message was lost')
  console.log('OK  failures carry error.details and the real message')
}

/* 4. "Run -> AI": the process is registered with ctx.jobs, owned by the agent -- */
{
  const started = []
  const jobs = {
    start(spec) {
      started.push(spec)
      return 'run-button-1'
    },
  }
  const agent = { id: 'session-abc', session: { header: { cwd: '/tmp' } } }
  const handleWithStreams = () => ({
    ...makeHandle(),
    observed: {
      stdout: { readFrom: (from) => ({ text: from === 0 ? 'hello\n' : '', nextOffset: 6, lossy: false }) },
      stderr: { readFrom: (from) => ({ text: '', nextOffset: from, lossy: false }) },
    },
  })
  const services = (extra) => ({
    shell: { resolve: spec, execute: async () => handleWithStreams() },
    agents: { list: () => [agent] },
    ...extra,
  })
  const mountWith = (svc) => {
    let dispatch
    const all = { ...svc, connection: { rpc: { handle: (_c, h) => ((dispatch = h), () => {}) } } }
    const ctx = {
      get: (n) => (Object.prototype.hasOwnProperty.call(all, n) ? all[n] : undefined),
      effect: () => () => {},
      interval: () => () => {},
      on: () => () => {},
      shell: all.shell,
    }
    const log = console.log
    console.log = () => {}
    apply(ctx)
    console.log = log
    return dispatch
  }

  // plain Run never touches the job registry
  const plain = mountWith(services({ jobs }))
  const r1 = await plain('start', { command: 'echo hello', sessionId: 'session-abc' })
  if (!r1.ok) fail(`plain run failed: ${JSON.stringify(r1)}`)
  if (started.length !== 0) fail('a plain Run must NOT register a job (it would wake the agent)')

  // Run -> AI registers one job owned by the session, labelled as user-run
  const ai = mountWith(services({ jobs }))
  const r2 = await ai('start', { command: 'echo hello', sessionId: 'session-abc', notifyAgent: true })
  if (!r2.ok) fail(`Run->AI failed: ${JSON.stringify(r2)}`)
  if (started.length !== 1) fail(`expected exactly one job, got ${started.length}`)
  const job = started[0]
  if (job.owner !== 'session-abc') fail(`job owner should be the session, got ${job.owner}`)
  if (!job.label.includes('echo hello') || !job.label.includes('user')) fail('label should say the user ran the command')
  if (r2.value.agentNotify !== 'registered') fail(`view should report registered, got ${r2.value.agentNotify}`)
  const hooks = job.run({ id: 'run-button-1' })
  const outcome = await hooks.done
  if (outcome.status !== 'completed' || outcome.detail !== 'exit code: 0') fail(`bad outcome ${JSON.stringify(outcome)}`)
  const read = job.output[0].read(0)
  if (read.text !== 'hello\n') fail('pull source should expose stdout')

  // No jobs service: still runs, and says why it cannot notify
  const noJobs = mountWith(services({}))
  const r3 = await noJobs('start', { command: 'echo hello', sessionId: 'session-abc', notifyAgent: true })
  if (!r3.ok) fail('without a jobs service the run must still succeed')
  if (r3.value.agentNotify === 'registered') fail('should not claim registration without a jobs service')
  console.log('OK  Run->AI registers an owned job; plain Run does not; no jobs service degrades gracefully')
}

/* 5. Interactive runs: a PTY from ctx.subprocess.spawnTerminal ---------------- */
{
  const { PassThrough } = await import('node:stream')
  /** A fake terminal that echoes like a tty, except while "echo is off". */
  const makeTerminal = (log) => {
    const output = new PassThrough()
    let finish
    const done = new Promise((resolve) => (finish = resolve))
    let echo = true
    const term = {
      pid: 1234,
      output,
      done,
      writes: [],
      async write(data) {
        term.writes.push(data)
        if (echo) output.write(data.replace(/\r/g, '\r\n'))
        else output.write('\r\n')
      },
      async signalForeground(signal) {
        log.push(`signal:${signal}`)
        return 1234
      },
      async terminate() {
        log.push('terminate')
        output.end()
        finish({ exitCode: null, signal: 'SIGTERM' })
      },
      prompt(text, { hidden = false } = {}) {
        echo = !hidden
        output.write(text)
      },
      exit(code) {
        output.end()
        finish({ exitCode: code, signal: null })
      },
    }
    return term
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
  const mountPty = ({ mode = 'workspace-write', withSandbox = true, extra = {} } = {}) => {
    const log = []
    const terminals = []
    const spawns = []
    let dispatch
    const all = {
      shell: {
        resolve: (r) => ({ ...spec(r), timeoutMs: 120000 }),
        execute: async () => {
          log.push('pipe')
          return makeHandle()
        },
      },
      subprocess: {
        async spawnTerminal(s) {
          spawns.push(s)
          const t = makeTerminal(log)
          terminals.push(t)
          return t
        },
      },
      sandboxPolicy: { defaultMode: mode, workspaceRoot: '/tmp', resolve: () => ({ mode, workspaceRoot: '/tmp' }) },
      ...(withSandbox ? { sandbox: { confine: async (argv, policy) => ({ argv: ['sandbox-exec', `-mode=${policy.mode}`, '--', ...argv] }) } } : {}),
      connection: { rpc: { handle: (_c, h) => ((dispatch = h), () => {}) } },
      ...extra,
    }
    const ctx = {
      get: (n) => (Object.prototype.hasOwnProperty.call(all, n) ? all[n] : undefined),
      effect: () => () => {},
      interval: () => () => {},
      on: () => () => {},
      shell: all.shell,
    }
    const logged = []
    const original = console.log
    console.log = (...a) => logged.push(a.join(' '))
    apply(ctx)
    console.log = original
    const call = async (ep, payload) => {
      const o = console.log
      console.log = (...a) => logged.push(a.join(' '))
      try {
        return await dispatch(ep, payload)
      } finally {
        console.log = o
      }
    }
    return { call, log, terminals, spawns, logged }
  }

  // read -p: prompt, answer through input, see the echo and the result
  {
    const h = mountPty()
    const info = await h.call('info', {})
    if (info.value.interactive !== true) fail('info should advertise interactive=true with a PTY provider')
    const r = await h.call('start', { command: 'read -p "name? " n; echo "hi $n"' })
    if (!r.ok) fail(`pty start failed: ${JSON.stringify(r)}`)
    if (r.value.interactive !== true) fail('view should mark the run interactive')
    if (h.log.includes('pipe')) fail('a PTY-capable host must not use the pipe executor')
    const s = h.spawns[0]
    if (s.argv[0] !== 'sandbox-exec' || s.argv[1] !== '-mode=workspace-write' || s.argv.at(-1) !== 'read -p "name? " n; echo "hi $n"') {
      fail(`confined argv wrong: ${JSON.stringify(s.argv)}`)
    }
    if (s.cwd !== '/tmp' || s.terminalType !== 'dumb' || s.env.NO_COLOR !== '1') fail(`bad spawn spec ${JSON.stringify(s)}`)
    const t = h.terminals[0]
    t.prompt('\u001b[1mname? \u001b[0m')
    await tick()
    let o = await h.call('output', { runId: r.value.runId })
    if (o.value.stdout !== 'name? ') fail(`ANSI should be stripped: ${JSON.stringify(o.value.stdout)}`)
    const w = await h.call('input', { runId: r.value.runId, data: 'kuri\r' })
    if (!w.ok) fail(`input failed ${JSON.stringify(w)}`)
    t.output.write('hi kuri\r\n')
    t.exit(0)
    await tick()
    o = await h.call('output', { runId: r.value.runId })
    if (o.value.stdout !== 'name? kuri\nhi kuri\n') fail(`unexpected transcript ${JSON.stringify(o.value.stdout)}`)
    if (o.value.status !== 'completed' || o.value.exitCode !== 0) fail(`bad final state ${JSON.stringify(o.value)}`)
    const late = await h.call('input', { runId: r.value.runId, data: 'x\r' })
    assertWireError(late, 'input after exit')
  }

  // password: hidden input is written to the PTY but appears nowhere
  {
    const h = mountPty({ mode: 'danger-full-access' })
    const r = await h.call('start', { command: 'sudo -k; sudo true && echo ok', sessionId: 'nobody' })
    if (h.spawns[0].argv.join(' ') !== 'bash -c sudo -k; sudo true && echo ok') fail(`full access must not confine: ${JSON.stringify(h.spawns[0].argv)}`)
    const t = h.terminals[0]
    t.prompt('Password:', { hidden: true })
    await tick()
    await h.call('input', { runId: r.value.runId, data: 'hunter2-secret\r' })
    t.output.write('ok\r\n')
    t.exit(0)
    await tick()
    const o = await h.call('output', { runId: r.value.runId })
    if (t.writes[0] !== 'hunter2-secret\r') fail('the password must reach the terminal')
    if (JSON.stringify(o).includes('hunter2')) fail('the password leaked into the run view')
    if (h.logged.some((line) => line.includes('hunter2'))) fail('the password leaked into the host log')
    if (o.value.stdout !== 'Password:\nok\n') fail(`transcript ${JSON.stringify(o.value.stdout)}`)
  }

  // ^C, ^D and Stop
  {
    const h = mountPty()
    const r = await h.call('start', { command: 'cat' })
    const id = r.value.runId
    const c = await h.call('input', { runId: id, signal: 'SIGINT' })
    if (!c.ok || !h.log.includes('signal:SIGINT')) fail('^C should signal the foreground job')
    assertWireError(await h.call('input', { runId: id, signal: 'SIGKILL' }), 'unsupported signal')
    await h.call('input', { runId: id, data: '\u0004' })
    if (h.terminals[0].writes.at(-1) !== '\u0004') fail('^D should write EOT')
    const k = await h.call('kill', { runId: id })
    if (k.value.killed !== true || !h.log.includes('terminate')) fail('Stop should terminate the terminal')
    await tick()
    const o = await h.call('output', { runId: id })
    if (o.value.status !== 'killed') fail(`status should be killed, got ${o.value.status}`)
  }

  // Run->AI reads the PTY transcript through observed.stdout
  {
    const jobs = []
    const agent = { id: 'session-abc', session: { header: { cwd: '/tmp' } } }
    const h = mountPty({ extra: { jobs: { start: (s) => jobs.push(s) }, agents: { list: () => [agent] } } })
    const r = await h.call('start', { command: 'echo hi', sessionId: 'session-abc', notifyAgent: true })
    if (r.value.agentNotify !== 'registered') fail('Run->AI should register on a PTY run too')
    h.terminals[0].output.write('hi\r\n')
    h.terminals[0].exit(3)
    const outcome = await jobs[0].run({}).done
    if (outcome.detail !== 'exit code: 3') fail(`job outcome ${JSON.stringify(outcome)}`)
    if (jobs[0].output[0].read(0).text !== 'hi\n') fail('job stdout reader should see the transcript')
    if (jobs[0].output[1].read(0).text !== '') fail('job stderr reader should be empty on a PTY')
  }

  // Fallbacks: confined mode without ctx.sandbox, or interactive:false -> pipe
  {
    const h = mountPty({ withSandbox: false })
    const r = await h.call('start', { command: 'echo hi' })
    if (!r.ok || !h.log.includes('pipe') || h.spawns.length !== 0) fail('missing sandbox provider must fall back to the pipe executor')
    if (r.value.interactive !== false) fail('pipe runs are not interactive')
    assertWireError(await h.call('input', { runId: r.value.runId, data: 'x' }), 'input on a pipe run')
    const h2 = mountPty()
    await h2.call('start', { command: 'echo hi', interactive: false })
    if (h2.spawns.length !== 0) fail('interactive:false must use the pipe executor')
  }

  // A CRLF / escape sequence split across chunks is reassembled
  {
    const h = mountPty()
    const r = await h.call('start', { command: 'x' })
    const t = h.terminals[0]
    t.output.write('a\r')
    t.output.write('\nb\u001b[3')
    t.output.write('1mc\r')
    t.output.write('d\r\n')
    t.exit(0)
    await tick()
    const o = await h.call('output', { runId: r.value.runId })
    if (o.value.stdout !== 'a\nbc\rd\n') fail(`split sequences: ${JSON.stringify(o.value.stdout)}`)
  }
  console.log('OK  interactive PTY runs: input, hidden password, ^C/^D/Stop, Run->AI, fallbacks')
}
