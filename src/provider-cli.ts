#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { StateStore } from './storage/store.js'
import { StickyRouter } from './routing/router.js'
import { verifyAccount, officialStatus, profileEnvironment } from './auth/official.js'
import { defaultStateDirectory } from './sessions/provider.js'
import { RouteBlocked, type Account, type Binding } from './routing/types.js'
import { runDoctor } from './doctor.js'
const args = process.argv.slice(2)
function flag(name: string, fallback = ''): string {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
const state = flag('--state', defaultStateDirectory())
const command = flag('--claude', 'claude')
let store: StateStore | undefined
const output = (x: unknown) => console.log(JSON.stringify(x, null, 2))
try {
  if (args[0] === 'doctor') {
    if (args.includes('--live')) {
      const budget = Number(flag('--budget-generations', '1'))
      if (!Number.isInteger(budget) || budget < 1 || budget > 12)
        throw new RouteBlocked('INVALID_LIVE_BUDGET')
      if (!args.includes('--extra-usage-off')) throw new RouteBlocked('EXTRA_USAGE_OFF_UNCONFIRMED')
      await officialStatus(command, 'default')
    }
    const result = await runDoctor({
      claudeCommand: command,
      live: args.includes('--live') ? 'always' : 'never',
      model: flag('--model', 'opus'),
      timeoutMs: 30000,
    })
    output({
      status: result.overall === 'fail' ? 'FAILED' : 'PASSED',
      live: args.includes('--live'),
      report: result,
    })
    if (result.overall === 'fail') process.exitCode = 1
  } else if (args[0] === 'accounts') {
    store = new StateStore(state)
    const router = new StickyRouter(store)
    if (args[1] === 'add' || args[1] === 'verify') {
      const alias = args[2]
      if (!alias) throw new RouteBlocked('ALIAS_REQUIRED')
      const old = store.list<Account>('accounts').find((a) => a.aliases.includes(alias))
      const profile = flag('--profile', old?.profileRef ?? 'default')
      if (args.includes('--login'))
        await new Promise<void>((resolve, reject) => {
          const child = spawn(command, ['auth', 'login', '--claudeai'], {
            env: profileEnvironment(profile),
            stdio: 'inherit',
            timeout: 180000,
          })
          child.once('error', reject)
          child.once('exit', (code) =>
            code === 0 ? resolve() : reject(new RouteBlocked('LOGIN_INCOMPLETE')),
          )
        })
      const account = await verifyAccount(
        store,
        command,
        alias,
        profile,
        args.includes('--extra-usage-off') || Boolean(old?.extraUsageOffConfirmedAt),
      )
      if (old && old.identity !== account.identity) throw new RouteBlocked('ALIAS_IDENTITY_CHANGED')
      router.register(account)
      output({
        status: 'PASSED',
        alias,
        identityVerified: true,
        billingSafety: account.extraUsageOffConfirmedAt ? 'user-confirmed-off' : 'unverified',
        models: Object.keys(account.models),
        liveMulti: 'unverified',
      })
    } else if (args[1] === 'remove') {
      const account = store.list<Account>('accounts').find((a) => a.aliases.includes(args[2] ?? ''))
      if (!account) throw new RouteBlocked('ACCOUNT_NOT_FOUND')
      account.aliases = account.aliases.filter((a) => a !== args[2])
      if (account.aliases.length) store.set('accounts', account.identity, account)
      else {
        account.state = 'DISABLED'
        store.set('accounts', account.identity, account)
      }
      output({ status: 'PASSED', officialProfileDeleted: false })
    } else
      output(
        store
          .list<Account>('accounts')
          .map((a) => ({
            aliases: a.aliases,
            state: a.state,
            identity: a.identity.slice(0, 12),
            billingSafety: a.extraUsageOffConfirmedAt ? 'user-confirmed-off' : 'unverified',
            windows: a.windows,
            models: Object.keys(a.models),
          })),
      )
  } else if (args[0] === 'explain-route') {
    store = new StateStore(state)
    const key = args[1]
    output(
      store
        .list<Binding>('bindings')
        .filter((b) => !key || b.key === key)
        .map((b) => ({ ...b, identity: b.identity.slice(0, 12) })),
    )
  } else if (args[0] === 'diagnostics' && args[1] === 'export' && args.includes('--redacted')) {
    store = new StateStore(state)
    output({
      schema: 1,
      accounts: store
        .list<Account>('accounts')
        .map((a) => ({
          id: store!.hash(a.identity).slice(0, 16),
          state: a.state,
          quotaKnown: a.windows.length > 0,
        })),
      bindings: store.list<Binding>('bindings').length,
      containsCredentials: false,
    })
  } else {
    output({
      commands: [
        'doctor --offline',
        'doctor --live --extra-usage-off --budget-generations 1',
        'accounts add <alias> [--profile <absolute-path>] [--login] --extra-usage-off',
        'accounts list --json',
        'accounts verify <alias>',
        'accounts remove <alias>',
        'explain-route [session-key]',
        'diagnostics export --redacted',
      ],
      options: ['--state <private-directory>', '--claude <official-executable>'],
    })
  }
} catch (error) {
  output({
    status: error instanceof RouteBlocked ? 'BLOCKED' : 'FAILED',
    code: error instanceof RouteBlocked ? error.code : 'COMMAND_FAILED',
  })
  process.exitCode = error instanceof RouteBlocked ? 2 : 1
} finally {
  store?.close()
}
