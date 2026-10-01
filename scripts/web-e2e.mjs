import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from 'playwright'
import {
  DshRpcError,
  WEB_E2E_SCHEMA_VERSION,
  dshRpc,
  historyAssistantMarkerCount,
  historyHasAssistantMarker,
  historyHasToolResultMarker,
  inspectClaudeCatalog,
  parseDshReadyUrl,
  stableFailureCode,
  summarizeHistory,
} from '../lib/web-e2e.js'
import { verifyProfileTransition } from '../lib/profile-verifier.js'

const EXPECTED_DSH_VERSION = '0.2.0-rc.2'
const EXPECTED_PLAYWRIGHT_VERSION = '1.61.1'
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1_024 * 1_024
const MAX_SERVER_OUTPUT_BYTES = 256 * 1_024
const SERVER_READY_TIMEOUT_MS = 90_000
const POLL_INTERVAL_MS = 100
const LIVE_TIMEOUT_MS = 180_000
const TITLE = 'DSH Claude E2E'
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const parsed = parseArgs({
  options: {
    live: { type: 'boolean' },
    keep: { type: 'boolean' },
    headed: { type: 'boolean' },
    'no-browser': { type: 'boolean' },
    report: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
  allowPositionals: false,
})

if (parsed.values.help === true) {
  process.stdout.write(`Usage: node scripts/web-e2e.mjs [options]

Options:
  --live          Run authenticated text, tool, cancellation, multi-turn, and restart cases
  --headed        Show Chromium instead of running headless
  --no-browser    Exercise only HTTP/RPC (browser coverage is required in CI)
  --report PATH   Write sanitized JSON evidence to PATH
  --keep          Retain the isolated fixture for diagnosis
  -h, --help      Show this help

The default keyless lane installs the packed plugin into a temporary Web
profile, boots current DSH on an OS-assigned loopback port, verifies the Claude
catalog/default/error boundary, opens the real WebUI, then proves process and
listener cleanup. --live first requires the installed doctor to pass.
`)
  process.exit(0)
}

const mode = parsed.values.live === true ? 'live' : 'keyless'
const useBrowser = parsed.values['no-browser'] !== true
const headed = parsed.values.headed === true
const keep = parsed.values.keep === true
const artifactDirectory = join(repository, '.artifacts')
const reportPath = resolve(parsed.values.report ?? join(artifactDirectory, `web-e2e-${mode}.json`))
const screenshotPath = join(artifactDirectory, `web-e2e-${mode}.png`)

class WebE2eFailure extends Error {
  constructor(code, message, evidence) {
    super(message)
    this.name = 'WebE2eFailure'
    this.code = code
    this.evidence = evidence
  }
}

function command(executable, args, cwd = repository, environment = process.env) {
  try {
    return execFileSync(executable, args, {
      cwd,
      env: environment,
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new WebE2eFailure('COMMAND_FAILED', `command failed: ${basename(executable)}`)
  }
}

function commandResult(executable, args, cwd = repository, environment = process.env) {
  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined || result.signal !== null) {
    throw new WebE2eFailure('COMMAND_FAILED', `command failed: ${basename(executable)}`)
  }
  return { status: result.status ?? 1, stdout: result.stdout }
}

function gitValue(args) {
  try {
    return command('git', args).trim()
  } catch {
    return 'unavailable'
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function duration(started) {
  return Math.round(performance.now() - started)
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function waitFor(probe, label, timeoutMs = LIVE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    await delay(POLL_INTERVAL_MS)
  }
  throw new WebE2eFailure('POLL_TIMEOUT', `timed out waiting for ${label}`)
}

function processRows() {
  if (process.platform === 'win32') return []
  try {
    return command('ps', ['-axo', 'pid=,ppid='])
      .split('\n')
      .flatMap((line) => {
        const fields = line.trim().split(/\s+/u)
        const pid = Number(fields[0])
        const ppid = Number(fields[1])
        return Number.isInteger(pid) && Number.isInteger(ppid) ? [{ pid, ppid }] : []
      })
  } catch {
    return []
  }
}

function descendantPids(rootPid) {
  const rows = processRows()
  const descendants = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if ((row.ppid === rootPid || descendants.has(row.ppid)) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return [...descendants]
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function listenerOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = connect({ host: '127.0.0.1', port })
    const finish = (open) => {
      socket.destroy()
      resolveOpen(open)
    }
    socket.setTimeout(500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function appendBounded(current, chunk) {
  const combined = `${current}${chunk.toString()}`
  return combined.length <= MAX_SERVER_OUTPUT_BYTES
    ? combined
    : combined.slice(combined.length - MAX_SERVER_OUTPUT_BYTES)
}

async function startWeb(dshBin, workspace, environment, pickerOverlay) {
  const child = spawn(
    dshBin,
    ['web', '--patch', pickerOverlay, '--host', '127.0.0.1', '--port', '0', '--no-open'],
    {
      cwd: workspace,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (child.pid === undefined) throw new WebE2eFailure('DSH_SPAWN_FAILED', 'DSH returned no PID')
  let output = ''
  let readyUrl
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new WebE2eFailure('DSH_READY_TIMEOUT', 'DSH Web did not become ready'))
    }, SERVER_READY_TIMEOUT_MS)
    const onData = (chunk) => {
      output = appendBounded(output, chunk)
      try {
        const parsedUrl = parseDshReadyUrl(output)
        if (parsedUrl !== undefined && readyUrl === undefined) {
          readyUrl = parsedUrl
          clearTimeout(timer)
          resolveReady(parsedUrl)
        }
      } catch {
        clearTimeout(timer)
        rejectReady(new WebE2eFailure('DSH_READY_URL_INVALID', 'DSH printed an invalid URL'))
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', () => {
      if (readyUrl === undefined) {
        clearTimeout(timer)
        rejectReady(new WebE2eFailure('DSH_EXITED_EARLY', 'DSH exited before readiness'))
      }
    })
  })
  try {
    const baseUrl = await ready
    const url = new URL(baseUrl)
    return {
      child,
      baseUrl,
      port: Number(url.port),
      pid: child.pid,
      output: () => output,
    }
  } catch (error) {
    await closeChild(child, 5_000)
    throw error
  }
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolveClose) => {
    const onClose = () => {
      clearTimeout(timer)
      resolveClose(true)
    }
    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolveClose(false)
    }, timeoutMs)
    child.once('close', onClose)
  })
}

async function closeChild(child, timeoutMs) {
  if (child.exitCode !== null) return false
  child.kill('SIGTERM')
  const graceful = await waitForChildClose(child, timeoutMs)
  if (graceful) return false
  if (child.exitCode === null) child.kill('SIGKILL')
  await waitForChildClose(child, timeoutMs)
  return true
}

async function stopWeb(instance) {
  const descendants = descendantPids(instance.pid)
  const forcedServerKill = await closeChild(instance.child, 10_000)
  const listenerClosed = await waitFor(
    async () => ((await listenerOpen(instance.port)) ? false : true),
    'the DSH listener to close',
    10_000,
  ).then(() => true)
  await waitFor(
    async () => (descendants.every((pid) => !processAlive(pid)) ? true : false),
    'DSH child processes to exit',
    5_000,
  ).catch(() => false)
  const leaked = descendants.filter(processAlive)
  for (const pid of leaked) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // The exact test-owned descendant may have exited between the probe and signal.
    }
  }
  await delay(250)
  const stillAlive = leaked.filter(processAlive)
  for (const pid of stillAlive) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The exact test-owned descendant may have exited between the probe and signal.
    }
  }
  return {
    pid: instance.pid,
    descendantsObserved: descendants.length,
    descendantsLeaked: leaked.length,
    forcedServerKill,
    listenerClosed,
    childrenExited: leaked.length === 0,
  }
}

async function history(baseUrl, sessionId) {
  return dshRpc(fetch, baseUrl, 'session.history', { sessionId, maxMessages: 100 })
}

async function waitForHistory(baseUrl, sessionId, predicate, label) {
  return waitFor(async () => {
    const page = await history(baseUrl, sessionId)
    return predicate(page) ? page : false
  }, label)
}

async function waitForTurnCount(baseUrl, sessionId, count) {
  return waitForHistory(
    baseUrl,
    sessionId,
    (page) => summarizeHistory(page).turnEndKinds.length >= count,
    `${String(count)} settled turns`,
  )
}

async function waitForSettledTurn(baseUrl, sessionId, previousTurnCount, label) {
  return waitForTurnCount(baseUrl, sessionId, previousTurnCount + 1).catch((error) => {
    if (error instanceof WebE2eFailure && error.code === 'POLL_TIMEOUT') {
      throw new WebE2eFailure('TURN_SETTLE_TIMEOUT', `timed out waiting for ${label}`)
    }
    throw error
  })
}

function requireNewAssistantMarker(page, marker, previousCount, code, summary, evidence) {
  if (historyAssistantMarkerCount(page, marker) <= previousCount) {
    throw new WebE2eFailure(code, summary, evidence)
  }
}

async function acknowledgeWelcome(page) {
  const welcome = page.getByRole('dialog', { name: 'Internal Testing Notice' })
  if ((await welcome.count()) === 0) return false
  await welcome.getByRole('button', { name: 'Continue' }).click()
  await welcome.waitFor({ state: 'detached', timeout: 10_000 })
  return true
}

async function connectWorkspace(page, workspace) {
  const chooser = page.getByRole('textbox', { name: 'Choose workspace' })
  await chooser.waitFor({ timeout: 30_000 })
  await chooser.click()
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.waitFor({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Edit path' }).click()
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  await pathInput.fill(workspace)
  await pathInput.press('Enter')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  await page
    .locator('textarea:enabled[placeholder="Describe what you want to build"]')
    .waitFor({ timeout: 30_000 })
}

async function openBrowser(baseUrl, workspace, connectFresh) {
  const browser = await chromium.launch({ headless: !headed })
  let complete = false
  try {
    const page = await browser.newPage({
      viewport: { width: 1680, height: 1000 },
      locale: 'en-US',
    })
    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', () => pageErrors.push('pageerror'))
    page.on('console', (entry) => {
      if (entry.type() === 'error') consoleErrors.push('console-error')
    })
    const assertClean = () => {
      if (pageErrors.length > 0 || consoleErrors.length > 0) {
        throw new WebE2eFailure('BROWSER_RUNTIME_ERROR', 'WebUI emitted a browser runtime error')
      }
      return { pageErrors: pageErrors.length, consoleErrors: consoleErrors.length }
    }
    await page.goto(baseUrl, { waitUntil: 'load' })
    const frame = page.locator('[class*="frame"]')
    await frame.waitFor({ timeout: 30_000 })
    const frameColumns = await frame.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
    )
    if (frameColumns !== 3) {
      throw new WebE2eFailure('BROWSER_FRAME_INVALID', 'WebUI frame is not three columns')
    }
    const welcomeAcknowledged = await acknowledgeWelcome(page)
    await delay(100)
    if ((await page.getByRole('dialog', { name: 'Add an API key to get started' }).count()) > 0) {
      throw new WebE2eFailure(
        'BROWSER_CREDENTIAL_ONBOARDING_WRONG',
        'WebUI requested DeepSeek credentials despite the active Claude route',
      )
    }
    if (connectFresh) await connectWorkspace(page, workspace)
    const trigger = page.getByRole('button', {
      name: /^Select model, current Claude Sonnet \(default\)/u,
    })
    await trigger.waitFor({ timeout: 30_000 })
    await trigger.click()
    const menu = page.getByRole('menu', { name: 'Model and reasoning effort' })
    await menu.waitFor({ timeout: 10_000 })
    await menu.getByRole('menuitem', { name: /^Model/u }).click()
    const provider = menu.getByRole('group', { name: 'Claude Code' })
    await provider.waitFor({ timeout: 10_000 })
    const names = await provider.getByRole('menuitemradio').allTextContents()
    const expectedNames = [
      'Claude Sonnet (default)',
      'Claude Sonnet',
      'Claude Opus',
      'Claude Haiku',
    ]
    if (
      names.length !== expectedNames.length ||
      expectedNames.some((expected, index) => !names[index]?.includes(expected))
    ) {
      throw new WebE2eFailure('BROWSER_MODEL_MENU_INVALID', 'Claude model menu is incomplete')
    }
    await page.screenshot({ path: screenshotPath, fullPage: true })
    await page.keyboard.press('Escape')
    if ((await page.getByText('Failed to load plugins', { exact: false }).count()) > 0) {
      throw new WebE2eFailure('BROWSER_PLUGIN_LOAD_FAILED', 'WebUI reported a plugin load failure')
    }
    const clean = assertClean()
    complete = true
    return {
      browser,
      page,
      assertClean,
      evidence: {
        playwright: EXPECTED_PLAYWRIGHT_VERSION,
        chromium: browser.version(),
        headed,
        welcomeAcknowledged,
        credentialOnboardingShown: false,
        frameColumns,
        modelOptions: names.length,
        ...clean,
        screenshot: basename(screenshotPath),
      },
    }
  } finally {
    if (!complete) await browser.close().catch(() => undefined)
  }
}

async function selectSessionInBrowser(page, title) {
  const tree = page.getByRole('tree', { name: 'Sessions' })
  await tree.waitFor({ timeout: 30_000 })
  const row = tree.getByText(title, { exact: true }).first()
  await row.waitFor({ timeout: 30_000 })
  await row.click()
}

const fixture = mkdtempSync(join(tmpdir(), 'dsh-claude-web-e2e-'))
const cliFixture = join(fixture, 'dsh-cli')
const profileHome = join(fixture, 'dsh-home')
const agentsHome = join(fixture, 'agents-home')
const packDirectory = join(fixture, 'package')
const workspace = join(fixture, 'workspace')
const pickerOverlay = join(fixture, 'browser-picker.overlay.yml')
mkdirSync(packDirectory, { recursive: true })
mkdirSync(workspace, { recursive: true })
mkdirSync(artifactDirectory, { recursive: true })
writeFileSync(
  pickerOverlay,
  [
    '- id: directory-picker',
    '  disabled: true',
    '- insert:',
    '    - id: directory-picker-browse',
    "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '    - id: ui-directory-picker-browse',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    '',
  ].join('\n'),
  'utf8',
)

const environment = {
  ...process.env,
  DSH_AGENTS_HOME: agentsHome,
  DSH_HOME: profileHome,
  NO_COLOR: '1',
}
if (mode === 'keyless') {
  delete environment.ANTHROPIC_API_KEY
  delete environment.CLAUDE_CODE_OAUTH_TOKEN
  delete environment.DEEPSEEK_API_KEY
}

const report = {
  schemaVersion: WEB_E2E_SCHEMA_VERSION,
  mode,
  success: false,
  startedAt: new Date().toISOString(),
  finishedAt: '',
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    dsh: EXPECTED_DSH_VERSION,
    playwright: EXPECTED_PLAYWRIGHT_VERSION,
    pluginCommit: gitValue(['rev-parse', 'HEAD']),
    pluginBranch: gitValue(['branch', '--show-current']) || 'detached',
    pluginDirty: gitValue(['status', '--porcelain']) !== '',
    profile: 'web',
    listenerHost: '127.0.0.1',
  },
  artifact: {},
  scenarios: [],
  cleanup: [],
}

let currentStage = 'provision'
let server
let browserState
let sessionId
let workspaceId
let dshBin

async function scenario(id, operation) {
  currentStage = id
  const started = performance.now()
  try {
    const evidence = await operation()
    report.scenarios.push({ id, status: 'pass', durationMs: duration(started), evidence })
    return evidence
  } catch (error) {
    report.scenarios.push({
      id,
      status: 'fail',
      durationMs: duration(started),
      failureCode: stableFailureCode(error),
      ...(error instanceof WebE2eFailure && error.evidence !== undefined
        ? { evidence: error.evidence }
        : {}),
    })
    throw error
  }
}

try {
  await scenario('profile.install', async () => {
    if (process.env.DSH_WEB_TEST_BIN === undefined) {
      mkdirSync(cliFixture, { recursive: true })
      writeFileSync(
        join(cliFixture, 'package.json'),
        `${JSON.stringify(
          {
            name: 'dsh-claude-web-e2e-fixture',
            private: true,
            packageManager: 'pnpm@10.34.5',
          },
          undefined,
          2,
        )}\n`,
        'utf8',
      )
      const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
      command(
        pnpmCommand,
        [
          'add',
          '--ignore-scripts',
          '--reporter=append-only',
          `@deepseek-ai/dsh@${EXPECTED_DSH_VERSION}`,
        ],
        cliFixture,
        environment,
      )
      dshBin = join(
        cliFixture,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'dsh.cmd' : 'dsh',
      )
    } else {
      dshBin = resolve(process.env.DSH_WEB_TEST_BIN)
    }
    if (!existsSync(dshBin)) throw new WebE2eFailure('DSH_BIN_MISSING', 'DSH binary is absent')
    const dshVersion = command(dshBin, ['--version'], repository, environment).trim()
    if (dshVersion !== EXPECTED_DSH_VERSION) {
      throw new WebE2eFailure('DSH_VERSION_MISMATCH', 'DSH version differs from the pinned release')
    }
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const packed = JSON.parse(
      command(
        npmCommand,
        ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
        repository,
        environment,
      ),
    )
    const filename = Array.isArray(packed) ? packed[0]?.filename : undefined
    if (typeof filename !== 'string') {
      throw new WebE2eFailure('PACK_ARTIFACT_MISSING', 'npm pack returned no artifact')
    }
    const tarball = join(packDirectory, filename)
    report.artifact = { filename, sha256: sha256(tarball) }
    const before = command(dshBin, ['--profile', 'web', '--dump-config'], repository, environment)
    command(
      dshBin,
      ['plugin', '--profile', 'web', 'add', tarball, '--ignore-scripts'],
      repository,
      environment,
    )
    const installed = command(
      dshBin,
      ['--profile', 'web', '--dump-config'],
      repository,
      environment,
    )
    const verification = verifyProfileTransition(before, installed)
    if (!verification.pass) {
      throw new WebE2eFailure(
        'PROFILE_TRANSITION_INVALID',
        'installed profile changed protected rows',
      )
    }
    return {
      dsh: dshVersion,
      beforeRows: verification.beforeRows,
      installedRows: verification.installedRows,
      allowedChangedRows: verification.allowedChangedRowIds,
    }
  })

  await scenario('plugin.doctor', async () => {
    const doctorArgs = [
      'plugin',
      '--profile',
      'web',
      'exec',
      'dsh-claude-plugin',
      'doctor',
      '--policy',
      mode === 'live' ? 'host-only' : 'bundled-only',
      mode === 'live' ? '--live' : '--no-live',
      '--json',
    ]
    const result = commandResult(dshBin, doctorArgs, repository, environment)
    let doctor
    try {
      doctor = JSON.parse(result.stdout)
    } catch {
      throw new WebE2eFailure('DOCTOR_REPORT_INVALID', 'doctor returned no JSON report')
    }
    const checks = new Map(
      Array.isArray(doctor.checks) ? doctor.checks.map((entry) => [entry.id, entry.status]) : [],
    )
    for (const id of ['sdk.startup', 'mcp.handshake', 'process.cleanup']) {
      if (checks.get(id) !== 'pass') {
        throw new WebE2eFailure('DOCTOR_CHECK_FAILED', `doctor check failed: ${id}`)
      }
    }
    if (mode === 'live' && checks.get('generation.live') !== 'pass') {
      throw new WebE2eFailure('CLAUDE_AUTH_REQUIRED', 'authenticated generation did not pass')
    }
    if (result.status !== 0) {
      throw new WebE2eFailure('DOCTOR_CHECK_FAILED', 'doctor exited nonzero')
    }
    return {
      overall: doctor.overall,
      sdkStartup: checks.get('sdk.startup'),
      mcpHandshake: checks.get('mcp.handshake'),
      processCleanup: checks.get('process.cleanup'),
      liveGeneration: checks.get('generation.live') ?? 'absent',
    }
  })

  await scenario('web.start', async () => {
    server = await startWeb(dshBin, workspace, environment, pickerOverlay)
    if (!(await listenerOpen(server.port))) {
      throw new WebE2eFailure('DSH_LISTENER_MISSING', 'ready port has no listener')
    }
    return { pid: server.pid, port: server.port, cwd: 'isolated-workspace' }
  })

  await scenario('web.http', async () => {
    const response = await fetch(server.baseUrl)
    const html = await response.text()
    if (!response.ok || !html.includes('<!doctype html>')) {
      throw new WebE2eFailure(
        'WEB_DOCUMENT_INVALID',
        'Web root did not serve the application shell',
      )
    }
    return {
      status: response.status,
      contentType: response.headers.get('content-type')?.split(';')[0] ?? 'missing',
      bytes: Buffer.byteLength(html),
    }
  })

  if (useBrowser) {
    await scenario('web.browser-model-menu', async () => {
      browserState = await openBrowser(server.baseUrl, workspace, true)
      const workspaces = await dshRpc(fetch, server.baseUrl, 'workspace.list', {})
      const matched = workspaces.items?.find(
        (entry) => basename(entry.path) === basename(workspace),
      )
      if (matched === undefined || typeof matched.workspaceId !== 'string') {
        throw new WebE2eFailure(
          'BROWSER_WORKSPACE_MISSING',
          'workspace picker created no workspace',
        )
      }
      workspaceId = matched.workspaceId
      sessionId = matched.sessionIds?.[0]
      if (typeof sessionId !== 'string') {
        throw new WebE2eFailure('BROWSER_SESSION_MISSING', 'workspace picker created no session')
      }
      return browserState.evidence
    })
  } else {
    await scenario('web.rpc-bootstrap', async () => {
      const createdWorkspace = await dshRpc(fetch, server.baseUrl, 'workspace.create', {
        path: workspace,
      })
      workspaceId = createdWorkspace.workspace.workspaceId
      const created = await dshRpc(fetch, server.baseUrl, 'session.create', { workspaceId })
      sessionId = created.sessionId
      return { workspaceCreated: createdWorkspace.created, sessionCreated: true }
    })
  }

  await scenario('web.rpc-model-discovery', async () => {
    const sessionModels = await dshRpc(fetch, server.baseUrl, 'session.models', { sessionId })
    const evidence = inspectClaudeCatalog(sessionModels)
    const providers = await dshRpc(fetch, server.baseUrl, 'llm.providers', {})
    const route = providers.providers?.find((entry) => entry.provider === 'claude-sdk-local')
    if (route?.active !== true || route.settingsNs !== '') {
      throw new WebE2eFailure('CLAUDE_ROUTE_TOPOLOGY_INVALID', 'Claude route is not active/keyless')
    }
    return { ...evidence, onboardingCredentialRequired: false }
  })

  await scenario('web.rpc-invalid-reasoning', async () => {
    let observed
    try {
      await dshRpc(fetch, server.baseUrl, 'session.selectModel', {
        sessionId,
        provider: 'claude-sdk-local',
        model: 'default',
        reasoningEffort: 'unsupported-e2e',
      })
    } catch (error) {
      observed = error
    }
    if (!(observed instanceof DshRpcError) || observed.code !== 'model-unavailable') {
      throw new WebE2eFailure('MODEL_ERROR_BOUNDARY_MISSING', 'invalid reasoning was accepted')
    }
    return { rejected: true, rpcCode: observed.code }
  })

  await dshRpc(fetch, server.baseUrl, 'session.rename', { sessionId, title: TITLE })

  let memoryMarker
  if (mode === 'live') {
    await scenario('live.text', async () => {
      const before = await history(server.baseUrl, sessionId)
      const beforeSummary = summarizeHistory(before)
      const browserRows = browserState?.page.locator('[data-chat-flow-kind="assistant-step"]')
      const beforeBrowserRows = await browserRows?.count()
      await dshRpc(fetch, server.baseUrl, 'session.prompt', {
        sessionId,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: 'This is a harmless local adapter smoke test. Calculate 19 + 23 and provide a brief answer.',
          },
        ],
      })
      const page = await waitForSettledTurn(
        server.baseUrl,
        sessionId,
        beforeSummary.turnEndKinds.length,
        'the text response to settle',
      )
      const summary = summarizeHistory(page)
      if (
        summary.assistantMessageCount <= beforeSummary.assistantMessageCount ||
        summary.assistantTextCharacters <= beforeSummary.assistantTextCharacters
      ) {
        throw new WebE2eFailure(
          'LIVE_TEXT_EMPTY',
          'settled text response contained no new assistant text',
          summary,
        )
      }
      if (browserRows !== undefined && beforeBrowserRows !== undefined) {
        await waitFor(
          async () => ((await browserRows.count()) > beforeBrowserRows ? true : false),
          'the assistant response to render in the browser',
          30_000,
        )
      }
      browserState?.assertClean()
      return summary
    })

    memoryMarker = `cedar-lantern-${createHash('sha256').update(crypto.randomUUID()).digest('hex').slice(0, 8)}`
    await scenario('live.multi-turn', async () => {
      const before = await history(server.baseUrl, sessionId)
      await dshRpc(fetch, server.baseUrl, 'session.prompt', {
        sessionId,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: `This is a harmless conversation-continuity test for the local adapter. Remember the phrase "${memoryMarker}" for my next question and acknowledge the request.`,
          },
        ],
      })
      const acknowledged = await waitForSettledTurn(
        server.baseUrl,
        sessionId,
        summarizeHistory(before).turnEndKinds.length,
        'the memory acknowledgement to settle',
      )
      const beforeRecallSummary = summarizeHistory(acknowledged)
      const beforeRecallMarkers = historyAssistantMarkerCount(acknowledged, memoryMarker)
      await dshRpc(fetch, server.baseUrl, 'session.prompt', {
        sessionId,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: 'For the same continuity test, what harmless phrase did I ask you to remember? Include the phrase in your answer.',
          },
        ],
      })
      const page = await waitForSettledTurn(
        server.baseUrl,
        sessionId,
        beforeRecallSummary.turnEndKinds.length,
        'the memory recall to settle',
      )
      requireNewAssistantMarker(
        page,
        memoryMarker,
        beforeRecallMarkers,
        'LIVE_MEMORY_MISMATCH',
        'settled recall response omitted the remembered phrase',
        summarizeHistory(page),
      )
      return summarizeHistory(page)
    })

    const toolMarker = '314159'
    await scenario('live.tool', async () => {
      const before = await history(server.baseUrl, sessionId)
      const beforeSummary = summarizeHistory(before)
      await dshRpc(fetch, server.baseUrl, 'session.prompt', {
        sessionId,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: `For this harmless local adapter tool test, use the bash tool exactly once to run printf ${toolMarker}. Then briefly report what the command returned.`,
          },
        ],
      })
      const page = await waitForSettledTurn(
        server.baseUrl,
        sessionId,
        beforeSummary.turnEndKinds.length,
        'the correlated bash round trip to settle',
      )
      const summary = summarizeHistory(page)
      if (!summary.toolCalls.includes('bash')) {
        throw new WebE2eFailure('LIVE_TOOL_CALL_MISSING', 'settled tool test made no bash call')
      }
      if (!historyHasToolResultMarker(page, toolMarker)) {
        throw new WebE2eFailure(
          'LIVE_TOOL_RESULT_MISMATCH',
          'settled tool test omitted the correlated output',
        )
      }
      if (
        summary.assistantMessageCount <= beforeSummary.assistantMessageCount ||
        summary.assistantTextCharacters <= beforeSummary.assistantTextCharacters
      ) {
        throw new WebE2eFailure(
          'LIVE_TOOL_REPLY_EMPTY',
          'settled tool response contained no new assistant text',
          summary,
        )
      }
      await browserState?.page.locator('[data-sample="bash"]').last().waitFor({ timeout: 30_000 })
      browserState?.assertClean()
      return summary
    })

    await scenario('live.cancellation', async () => {
      const created = await dshRpc(fetch, server.baseUrl, 'session.create', { workspaceId })
      const cancellationId = created.sessionId
      const before = await history(server.baseUrl, cancellationId)
      const beforeTurns = summarizeHistory(before).turnEndKinds.length
      await dshRpc(fetch, server.baseUrl, 'session.prompt', {
        sessionId: cancellationId,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: 'For this harmless local adapter cancellation test, use bash to run sleep 20, wait for it, then say "Cancellation test unexpectedly completed."',
          },
        ],
      })
      const started = await waitForHistory(
        server.baseUrl,
        cancellationId,
        (value) => {
          const summary = summarizeHistory(value)
          return summary.toolCalls.includes('bash') || summary.turnEndKinds.length > beforeTurns
        },
        'the cancellable bash call or an early turn boundary',
      )
      if (!summarizeHistory(started).toolCalls.includes('bash')) {
        throw new WebE2eFailure(
          'LIVE_CANCELLATION_TOOL_MISSING',
          'cancellation test settled before issuing bash',
        )
      }
      await dshRpc(fetch, server.baseUrl, 'session.cancel', { sessionId: cancellationId })
      const page = await waitForHistory(
        server.baseUrl,
        cancellationId,
        (value) => {
          const kinds = summarizeHistory(value).turnEndKinds
          return kinds.some((kind) => ['aborted', 'cancelled', 'interrupted'].includes(kind))
        },
        'the cancelled turn boundary',
      )
      const evidence = summarizeHistory(page)
      if (historyHasAssistantMarker(page, 'Cancellation test unexpectedly completed.')) {
        throw new WebE2eFailure('CANCELLATION_IGNORED', 'cancelled turn emitted terminal marker')
      }
      return evidence
    })

    await scenario('live.restart', async () => {
      browserState?.assertClean()
      await browserState?.browser.close()
      browserState = undefined
      const firstStop = await stopWeb(server)
      report.cleanup.push({ boundary: 'restart', ...firstStop })
      if (!firstStop.childrenExited) {
        throw new WebE2eFailure('CHILD_PROCESS_LEAK', 'Claude child survived DSH restart boundary')
      }
      server = await startWeb(dshBin, workspace, environment, pickerOverlay)
      const before = await history(server.baseUrl, sessionId)
      if (!historyHasAssistantMarker(before, memoryMarker)) {
        throw new WebE2eFailure('RESTART_HISTORY_MISSING', 'history marker was not durable')
      }
      const beforeSummary = summarizeHistory(before)
      const beforeRestartMarkers = historyAssistantMarkerCount(before, memoryMarker)
      await dshRpc(fetch, server.baseUrl, 'session.prompt', {
        sessionId,
        mode: 'queue',
        content: [
          {
            type: 'text',
            text: 'This is the final step of the same harmless adapter continuity test. After the restart, what phrase did I ask you to remember? Include the phrase in your answer.',
          },
        ],
      })
      const after = await waitForSettledTurn(
        server.baseUrl,
        sessionId,
        beforeSummary.turnEndKinds.length,
        'the post-restart continuity response to settle',
      )
      requireNewAssistantMarker(
        after,
        memoryMarker,
        beforeRestartMarkers,
        'LIVE_RESTART_MISMATCH',
        'settled post-restart response omitted the continuity evidence',
        summarizeHistory(after),
      )
      if (useBrowser) {
        browserState = await openBrowser(server.baseUrl, workspace, false)
        await selectSessionInBrowser(browserState.page, TITLE)
        await browserState.page.getByText(memoryMarker, { exact: false }).last().waitFor({
          timeout: 30_000,
        })
        browserState.assertClean()
        await browserState.page.screenshot({ path: screenshotPath, fullPage: true })
      }
      return {
        historyBeforeRestart: summarizeHistory(before),
        historyAfterRestart: summarizeHistory(after),
        browserRecovered: useBrowser,
      }
    })
  }

  report.success = report.scenarios.every((entry) => entry.status === 'pass')
} catch (error) {
  if (process.env.DSH_WEB_E2E_DEBUG === '1') {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  }
  report.failure = { stage: currentStage, code: stableFailureCode(error) }
  if (error instanceof WebE2eFailure && /^[A-Z0-9_]{1,64}$/u.test(error.code)) {
    report.failure.code = error.code
  }
} finally {
  currentStage = 'cleanup'
  if (browserState !== undefined) {
    try {
      await browserState.browser.close()
    } catch {
      report.success = false
      report.cleanup.push({ boundary: 'final-browser', closed: false })
    }
  }
  if (server !== undefined && server.child.exitCode === null) {
    try {
      const finalStop = await stopWeb(server)
      report.cleanup.push({ boundary: 'final', ...finalStop })
      if (!finalStop.childrenExited || !finalStop.listenerClosed) report.success = false
    } catch (error) {
      report.success = false
      report.cleanup.push({
        boundary: 'final',
        closed: false,
        failureCode: stableFailureCode(error),
      })
    }
  }
  report.finishedAt = new Date().toISOString()
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8')
  if (keep) process.stderr.write(`Web E2E fixture retained at ${fixture}\n`)
  else rmSync(fixture, { recursive: true, force: true })
}

process.stdout.write(
  `${JSON.stringify(
    {
      success: report.success,
      mode: report.mode,
      scenarios: report.scenarios.length,
      report: reportPath,
      screenshot: useBrowser ? screenshotPath : undefined,
    },
    undefined,
    2,
  )}\n`,
)

if (!report.success) process.exitCode = 1
