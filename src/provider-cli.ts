#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { isCliEntrypoint } from './entrypoint.js'
import { StateStore, recoverStateLock } from './storage/store.js'
import { officialStatus } from './auth/official.js'
import { defaultStateDirectory } from './storage/paths.js'
import { RouteBlocked, type Account, type Binding } from './routing/types.js'
import { runDoctor } from './doctor.js'
import { AccountController } from './ui/controller.js'
import { resolveCliState } from './cli-state.js'
import { parseLoginPayload } from './login-view.js'
import type { LoginView } from './login-view.js'
export interface LoginIo {
  writeUrl(url: string): void
  readLine(): Promise<string>
}
export interface CliDependencies {
  output?: (value: unknown) => void
  store?: (directory: string, readOnly: boolean) => StateStore
  doctor?: typeof runDoctor
  status?: typeof officialStatus
  controller?: (store: StateStore, command: string) => AccountController
  recover?: typeof recoverStateLock
  resolveState?: typeof resolveCliState
  loginIo?: LoginIo
}
function defaultLoginIo(): LoginIo {
  return {
    writeUrl(url) {
      process.stderr.write(`${url}\n`)
    },
    readLine() {
      return new Promise((resolve) => {
        const lines = createInterface({ input: process.stdin })
        lines.once('line', (line) => {
          lines.close()
          resolve(line)
        })
      })
    },
  }
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
async function pollLogin(
  controller: AccountController,
  alias: string,
  profile: string,
  view: LoginView,
): Promise<LoginView> {
  let current = view
  while (current.phase === 'opening' || current.phase === 'finishing') {
    await wait(200)
    current = (await controller.login(parseLoginPayload({ op: 'read', alias, profile }))).exchange
  }
  return current
}
async function loginOnCli(
  controller: AccountController,
  alias: string,
  profile: string,
  extraUsageOff: boolean,
  io: LoginIo,
): Promise<unknown> {
  let view = (
    await controller.login(
      parseLoginPayload({
        op: 'open',
        attempt: randomUUID(),
        alias,
        profile,
        extraUsageOff,
      }),
    )
  ).exchange
  view = await pollLogin(controller, alias, profile, view)
  if (view.phase === 'needs_code') {
    io.writeUrl(view.authorizeUrl)
    const line = await io.readLine()
    view = (
      await controller.login(
        parseLoginPayload({
          op: 'paste',
          attempt: view.attempt,
          alias,
          profile,
          code: line,
        }),
      )
    ).exchange
    view = await pollLogin(controller, alias, profile, view)
  }
  if (view.phase === 'failed') throw new RouteBlocked(view.failureCode)
  return controller.status()
}
export async function runProviderCli(args: string[], deps: CliDependencies = {}): Promise<number> {
  const flag = (name: string, fallback = '') => {
    const i = args.indexOf(name)
    return i < 0 ? fallback : (args[i + 1] ?? fallback)
  }
  let state = defaultStateDirectory()
  const command = flag('--claude', 'claude'),
    output = deps.output ?? ((x) => console.log(JSON.stringify(x, null, 2)))
  let store: StateStore | undefined
  const open = (readOnly = false) =>
    (store ??= (deps.store ?? ((path, read) => new StateStore(path, { readOnly: read })))(
      state,
      readOnly,
    ))
  try {
    if (['doctor', 'accounts', 'explain-route', 'diagnostics'].includes(args[0] ?? ''))
      state = await (deps.resolveState ?? resolveCliState)(args)
    if (args[0] === 'doctor') {
      if (args.includes('--recover')) {
        output((deps.recover ?? recoverStateLock)(state))
        return 0
      }
      const live = args.includes('--live')
      if (live) {
        const budget = Number(flag('--budget-generations', '1'))
        if (!Number.isInteger(budget) || budget < 1 || budget > 12)
          throw new RouteBlocked('INVALID_LIVE_BUDGET')
        if (!args.includes('--extra-usage-off'))
          throw new RouteBlocked('EXTRA_USAGE_OFF_UNCONFIRMED')
        await (deps.status ?? officialStatus)(command, 'default')
      }
      const result = await (deps.doctor ?? runDoctor)({
        claudeCommand: command,
        live: live ? 'always' : 'never',
        model: flag('--model', 'opus'),
        timeoutMs: 30000,
      })
      output({ status: result.overall === 'fail' ? 'FAILED' : 'PASSED', live, report: result })
      return result.overall === 'fail' ? 1 : 0
    }
    if (args[0] === 'accounts') {
      const action = args[1] ?? 'list',
        s = open(action === 'list'),
        controller = deps.controller?.(s, command) ?? new AccountController(() => s, command)
      if (action === 'list') output({ ...controller.status(), stateDirectory: state })
      else {
        if (!args[2]) throw new RouteBlocked('ALIAS_REQUIRED')
        if (args.includes('--login')) {
          const typed = args.includes('--profile') ? flag('--profile') : 'default'
          output(
            await loginOnCli(
              controller,
              args[2],
              typed === '' ? 'default' : typed,
              args.includes('--extra-usage-off'),
              deps.loginIo ?? defaultLoginIo(),
            ),
          )
        } else
          output(
            await controller.execute(action, {
              alias: args[2],
              ...(args.includes('--profile') ? { profile: flag('--profile') } : {}),
              extraUsageOff: args.includes('--extra-usage-off'),
            }),
          )
      }
    } else if (args[0] === 'explain-route') {
      const selected = args[1]
        ? [open(true).get<Binding>('bindings', args[1])].filter(
            (binding): binding is Binding => binding !== undefined,
          )
        : open(true).list<Binding>('bindings')
      output(selected.map((binding) => ({ ...binding, identity: binding.identity.slice(0, 12) })))
    } else if (args[0] === 'diagnostics' && args[1] === 'export' && args.includes('--redacted')) {
      const s = open(true)
      output({
        schema: 1,
        accounts: s.list<Account>('accounts').map((a) => ({
          id: s.hash(a.identity).slice(0, 16),
          state: a.state,
          quotaKnown: a.windows.length > 0,
        })),
        bindings: s.count('bindings'),
        containsCredentials: false,
      })
    } else
      output({
        commands: [
          'doctor --offline',
          'doctor --recover',
          'doctor --live --extra-usage-off --budget-generations 1',
          'accounts add <alias> [--profile <absolute-path>] [--login] --extra-usage-off',
          'accounts list --json',
          'accounts verify <alias>',
          'accounts remove <alias>',
          'accounts setDefault <alias>',
          'explain-route [session-key]',
          'diagnostics export --redacted',
        ],
        options: [
          '--state <private-directory>',
          '--dsh-profile <profile-name>',
          '--claude <official-executable>',
        ],
      })
    return 0
  } catch (error) {
    const code =
      error instanceof RouteBlocked
        ? error.code
        : error instanceof Error && error.message.startsWith('STATE_IN_USE')
          ? 'STATE_IN_USE'
          : 'COMMAND_FAILED'
    output({
      status: error instanceof RouteBlocked || code === 'STATE_IN_USE' ? 'BLOCKED' : 'FAILED',
      code,
    })
    return error instanceof RouteBlocked || code === 'STATE_IN_USE' ? 2 : 1
  } finally {
    store?.close()
  }
}
if (isCliEntrypoint(import.meta.url, process.argv[1]))
  process.exitCode = await runProviderCli(process.argv.slice(2))
