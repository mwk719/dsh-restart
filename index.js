/**
 * Restart button for DeepSeek Harness Desktop — Host half.
 *
 * The Desktop shell draws the Windows caption menubar itself and its Application popup is a native
 * Electron menu built from `applicationItems()` inside `app.asar`, so no plugin can insert a row
 * into it. What a plugin CAN do is place its own control in that same caption row (the Client half)
 * and perform a real restart from this half.
 *
 * How the restart works: the Desktop Host is the Electron executable running in Node mode
 * (`ELECTRON_RUN_AS_NODE=1`, spawned by the Electron main process with an IPC channel), so
 * `process.execPath` IS the application executable and `process.ppid` is the Electron main process.
 * A restart is therefore: launch a detached helper, let it kill the app tree, then launch the
 * executable again — the same thing quitting and reopening does.
 *
 * A restart ends every running turn, so every press has to be asked for twice: this route refuses
 * a press that did not arrive as a confirmation (`?force=1`) and answers with what would be
 * interrupted. The button asks first, and the route holds that promise even for a page that is
 * older than the code it is talking to.
 *
 * Nothing here may throw into the server: a route that rejects can take a request down, and this
 * plugin is only useful while the rest of the app keeps working.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-restart'
/** The caption menubar is served by the same web server as the page, so that is the only service needed. */
export const inject = ['webServer']

/** The one route the button calls; `?force=1` is the second, confirming press. */
const RESTART_PATH = '/dsh-restart/restart'
/** Where the Client half reports that its button was really attached. */
const STATE_PATH = '/dsh-restart/state'
/** A same-origin page sets this itself; a cross-site form post cannot, and fails the preflight. */
const BUTTON_HEADER = 'x-dsh-restart'
/** The helper that outlives the process it replaces. */
const HELPER_PATH = fileURLToPath(new URL('./restart-child.mjs', import.meta.url))
/** Reported by `/state`, so a live page can be told apart from one still serving older code. */
const GUARD = 'dialog-confirm-1'
/** What the Client half may report; a page's own words never reach the log unfiltered. */
const EVENTS = new Set(['button-attached', 'dialog-open', 'dialog-cancel', 'dialog-confirm', 'dialog-failed', 'dialog-stuck'])

/** Where a restart writes what it did, so a button that "did nothing" can be explained afterwards. */
function stateHome() {
  const fromEnv = process.env.HOME || process.env.USERPROFILE
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : homedir()
}
const LOG_PATH = join(stateHome(), '.dsh', 'dsh-restart.log')

/** One line per event, with control bytes folded so a message cannot forge or repaint a line. */
function log(value) {
  try {
    mkdirSync(join(stateHome(), '.dsh'), { recursive: true })
    const text = String(value ?? '')
      .replace(/[\r\n\u2028\u2029]+/gu, ' ')
      .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
      .slice(0, 2000)
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${text}\n`)
  } catch {
    /* evidence is worth less than the answer this file is part of */
  }
}

/** Answer with JSON, once, whatever state the response is already in. */
function sendJson(res, status, body) {
  try {
    if (res?.headersSent === true) {
      if (res?.writableEnded !== true && res?.destroyed !== true) res.end()
      return
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch {
    /* the socket is gone; there is nobody left to answer */
  }
}

/**
 * The facts a restart needs, or null when this Host is not the Desktop application.
 *
 * `ELECTRON_RUN_AS_NODE` is set by the shell exactly for the Desktop Host, which is what makes
 * `process.execPath` the application executable rather than a `node` binary.
 */
function restartTarget() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return null
  const executable = String(process.execPath ?? '')
  if (executable === '' || !existsSync(executable)) return null
  const mainPid = Number(process.ppid)
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) return null
  return { executable, mainPid, hostPid: Number(process.pid) }
}

/**
 * How many sessions would lose work to a restart right now.
 *
 * A session is only counted while it is not idle: an idle agent in the registry is a conversation,
 * not work, and counting it would make every press ask twice. Anything unreadable counts as none —
 * a guard that refuses every restart because a list could not be read would turn the button into
 * one that never works.
 */
function runningSessions(ctx) {
  try {
    const agents = ctx.get('agents')
    const list = typeof agents?.list === 'function' ? agents.list() : []
    if (!Array.isArray(list)) return 0
    let running = 0
    for (const agent of list) {
      try {
        const status = agent?.status
        if (typeof status === 'string' && status !== 'idle') running += 1
      } catch {
        /* one unreadable agent is not a reason to refuse the press */
      }
    }
    return running
  } catch {
    return 0
  }
}

/** What the Client half last reported about its own button; kept across a plugin reload. */
const STATE_KEY = Symbol.for('dsh-restart.state')
const shared = globalThis[STATE_KEY] ?? (globalThis[STATE_KEY] = { mounted: null })

/**
 * Start the helper that replaces this application. It runs detached so it survives the kill it is
 * about to perform, and it is the only process that outlives this one on purpose.
 */
function startHelper(target) {
  try {
    const child = spawn(process.execPath, [HELPER_PATH, String(target.mainPid), String(target.hostPid), target.executable, LOG_PATH], {
      cwd: dirname(target.executable),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    child.once('error', (error) => log(`restart helper failed to start: ${error?.message ?? error}`))
    child.unref()
    log(`restart helper started (pid ${String(child.pid)}, main ${String(target.mainPid)}, host ${String(target.hostPid)})`)
  } catch (error) {
    log(`cannot start the restart helper: ${error?.message ?? error}`)
  }
}

/** Register one route, guarded so a refusal costs a status instead of the connection. */
function guarded(handler) {
  return (req, res) => {
    try {
      return handler(req, res)
    } catch (error) {
      log(`a route body threw: ${error?.message ?? error}`)
      sendJson(res, 503, { status: 'failed' })
      return undefined
    }
  }
}

function createHandlers(ctx) {
  const restartHandler = (req, res) => {
    if (req?.method !== 'POST') return sendJson(res, 405, { status: 'failed', detail: 'POST required' })
    if (req?.headers?.[BUTTON_HEADER] !== '1') return sendJson(res, 403, { status: 'failed', detail: 'missing client header' })
    const target = restartTarget()
    if (target === null) {
      log('a restart was asked for, but this Host is not the Desktop application')
      return sendJson(res, 409, { status: 'unsupported', detail: 'this Host is not the DeepSeek Harness desktop application' })
    }
    // A restart ends every running turn, so only a confirming press may cause one. `force=1` is that
    // confirmation, and the count of sessions it would interrupt travels back with the refusal.
    let forced = false
    let dryRun = false
    try {
      const query = new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams
      forced = query.get('force') === '1'
      // A press that must not restart anything: the same decision the real press takes, answered
      // without a helper, so the guard can be checked against live sessions.
      dryRun = query.get('dry') === '1'
    } catch {
      forced = false
    }
    const busy = runningSessions(ctx)
    if (dryRun) {
      log(`restart dry run: ${String(busy)} session(s) running, would ask first`)
      return sendJson(res, 200, { status: 'confirm', busy, dry: true })
    }
    if (!forced) {
      // Every restart is a confirmation. A press that did not arrive as one kills nothing, whatever
      // sessions it found, and the answer carries what the confirmation would cost.
      log(`restart held for confirmation: ${String(busy)} session(s) running`)
      return sendJson(res, 409, { status: 'confirm', busy, detail: 'a restart needs a confirming press' })
    }
    // The answer leaves before anything is killed: a page that never saw its answer would report a
    // restart that did happen as one that did not.
    sendJson(res, 202, { status: 'restarting', executable: target.executable })
    log(`restart requested from the titlebar button${forced ? ` (confirmed, ${String(busy)} session(s) interrupted)` : ''} (main ${String(target.mainPid)}, host ${String(target.hostPid)})`)
    setTimeout(() => startHelper(target), 150)
  }

  const stateHandler = (req, res) => {
    if (req?.method === 'POST') {
      // The page says what it did — its button landed, a dialog opened, a press was cancelled — so a
      // press can be accounted for later even though the page itself is gone after a restart.
      let event = ''
      try {
        event = String(new URL(String(req.url ?? '/'), 'http://127.0.0.1').searchParams.get('event') ?? '')
      } catch {
        event = ''
      }
      // A page without an event is the older report, whose only meaning was "the button is here".
      if (event === '' || event === 'button-attached') {
        shared.mounted = { at: Date.now(), where: 'caption-menubar' }
        log('the button reported itself attached to the caption menubar')
      } else if (EVENTS.has(event)) {
        log(`the button reported: ${event}`)
      }
      return sendJson(res, 200, { status: 'ok' })
    }
    return sendJson(res, 200, {
      status: 'ok',
      guard: GUARD,
      desktop: restartTarget() !== null,
      busy: runningSessions(ctx),
      mounted: shared.mounted,
      log: LOG_PATH,
    })
  }

  return { restartHandler, stateHandler }
}

export function apply(ctx) {
  const server = ctx.get('webServer')
  if (server === undefined || server === null || typeof server.register !== 'function') {
    log('no web server in this composition, so the restart button has nothing to answer it')
    return
  }
  const { restartHandler, stateHandler } = createHandlers(ctx)
  ctx.effect(() => {
    const disposers = []
    for (const [path, handler] of [
      [RESTART_PATH, restartHandler],
      [STATE_PATH, stateHandler],
    ]) {
      try {
        const dispose = server.register({ kind: 'exact', path, handler: guarded(handler) })
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        log(`cannot answer ${path}: ${error?.message ?? error}`)
      }
    }
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          /* the route is already gone */
        }
      }
    }
  })
}
