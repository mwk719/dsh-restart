/**
 * Restart helper — the process that outlives the application it replaces.
 *
 * It is started detached by the Host half and is a child of the Host, so it must never kill the
 * app tree with a recursive/tree termination: that would kill itself before it could launch the
 * application again. It therefore terminates the Electron main process and the Host process by
 * their own ids, waits for the socket the Host owns to be released, and then launches the
 * executable as a normal user launch.
 *
 * Nothing is killed until the executable has been found: a helper that cannot relaunch must leave
 * a working application alone rather than close one it cannot bring back.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
const mainPid = Number.parseInt(argv[0] ?? '', 10)
const hostPid = Number.parseInt(argv[1] ?? '', 10)
const executable = argv[2] ?? ''
const logPath = argv[3] ?? ''

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(value) {
  if (logPath === '') return
  try {
    appendFileSync(logPath, `${new Date().toISOString()} helper: ${String(value).replace(/[\r\n]+/gu, ' ').slice(0, 2000)}\n`)
  } catch {
    /* the log is evidence, not a promise this helper can keep by blocking */
  }
}

/** Terminate one process by id, without a tree walk that would reach this helper itself. */
function terminate(pid, label) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    log(`${label}: no usable pid (${String(pid)})`)
    return false
  }
  try {
    process.kill(pid, 'SIGKILL')
    log(`${label} ${pid} terminated`)
    return true
  } catch (error) {
    log(`${label} ${pid} was already gone or could not be terminated (${error?.code ?? error?.message ?? error})`)
    return false
  }
}

/** Launch the application the way a user launch would, without this helper's Node-mode marker. */
function relaunch() {
  const env = { ...process.env }
  // Inherited from the Desktop Host: kept for this helper, fatal for a real application launch.
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [], {
    cwd: dirname(executable),
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.once('error', (error) => log(`launch failed: ${error?.message ?? error}`))
  child.unref()
  return child
}

async function main() {
  if (executable === '' || !existsSync(executable)) {
    // Closing an application this helper cannot reopen would leave nothing running at all.
    log(`cannot restart: ${executable === '' ? 'no executable path was passed' : `${executable} is missing`}`)
    return
  }
  log(`restarting: main ${String(mainPid)}, host ${String(hostPid)}, executable ${executable}`)
  await sleep(700)
  // The window first, so the person sees the application close instead of an error page: a Host
  // that dies before its shell makes the shell report a fatal Host failure.
  terminate(mainPid, 'electron main')
  await sleep(700)
  // Then the Host, which owns the HTTP socket the new instance has to bind.
  terminate(hostPid, 'host')
  await sleep(1600)
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let child = null
    try {
      child = relaunch()
    } catch (error) {
      log(`launch attempt ${String(attempt)} threw: ${error?.message ?? error}`)
    }
    if (child === null) {
      await sleep(1200)
      continue
    }
    // A launch that exits on its own failed: the usual cause is the previous instance still holding
    // the window lock or the port, so the next attempt waits a little longer before trying again.
    await sleep(2500)
    if (child.exitCode === null) {
      log(`application relaunched (pid ${String(child.pid)})`)
      return
    }
    log(`launched process exited with ${String(child.exitCode)}; trying again`)
    await sleep(1200 * attempt)
  }
  log('could not relaunch the application; open it manually')
}

await main()
