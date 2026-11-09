import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { Account } from './routing/types.js'
import { RouteBlocked } from './routing/types.js'
import { StateStore } from './storage/store.js'

const execute = promisify(execFile)
const CREDENTIAL_FILE = '.credentials.json'

export function credentialServiceName(directory: string | undefined): string {
  if (directory === undefined) return 'Claude Code-credentials'
  const hash = createHash('sha256').update(directory.normalize('NFC')).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${hash}`
}

type KeychainCopy = (stagingDir: string, profileRef: string) => Promise<boolean>

function profileDirectory(profileRef: string): string {
  return profileRef === 'default' ? join(homedir(), '.claude') : profileRef
}

function replaceCredentials(destinationDir: string, read: () => Buffer): void {
  const temporary = join(destinationDir, `.${CREDENTIAL_FILE}.${process.pid}.tmp`)
  try {
    mkdirSync(destinationDir, { recursive: true, mode: 0o700 })
    writeFileSync(temporary, read(), { mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, join(destinationDir, CREDENTIAL_FILE))
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new RouteBlocked('LOGIN_NOT_COMMITTED', undefined, { cause: error })
  }
}

export function installVerifiedCredentials(stagingDir: string, profileRef: string): boolean {
  const source = join(stagingDir, CREDENTIAL_FILE)
  if (!existsSync(source)) return false
  replaceCredentials(profileDirectory(profileRef), () => readFileSync(source))
  return true
}

// Claude Code reads the Keychain item before the file, so on macOS the Keychain copy is the commit
// and the file is restored when it fails; elsewhere the file is the only store.
export async function commitVerifiedLogin(
  stagingDir: string,
  profileRef: string,
  copyKeychain: KeychainCopy | null = process.platform === 'darwin' ? installDarwinKeychain : null,
): Promise<void> {
  const destinationDir = profileDirectory(profileRef)
  const destination = join(destinationDir, CREDENTIAL_FILE)
  let previous: Buffer | undefined
  try {
    previous = existsSync(destination) ? readFileSync(destination) : undefined
  } catch (error) {
    throw new RouteBlocked('LOGIN_NOT_COMMITTED', undefined, { cause: error })
  }
  const fileInstalled = installVerifiedCredentials(stagingDir, profileRef)
  if (copyKeychain === null ? fileInstalled : await copyKeychain(stagingDir, profileRef)) return
  if (fileInstalled) {
    if (previous === undefined) rmSync(destination, { force: true })
    else replaceCredentials(destinationDir, () => previous)
  }
  throw new RouteBlocked('LOGIN_NOT_COMMITTED')
}

function darwinUser(): string {
  const named = process.env.USER || process.env.LOGNAME
  if (named !== undefined && named.length > 0) return named
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

export function discardStagingKeychain(stagingDir: string): void {
  if (process.platform !== 'darwin' || stagingDir.length === 0) return
  const user = darwinUser()
  if (user.length === 0) return
  void execute(
    'security',
    ['delete-generic-password', '-a', user, '-s', credentialServiceName(stagingDir)],
    { timeout: 5_000 },
  ).catch(() => undefined)
}

export async function installDarwinKeychain(
  stagingDir: string,
  profileRef: string,
): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  const user = darwinUser()
  if (user.length === 0 || /["\\\r\n]/.test(user)) return false
  const destination = profileRef === 'default' ? undefined : profileRef
  const from = credentialServiceName(stagingDir)
  const to = credentialServiceName(destination)
  let secret: string
  try {
    const read = await execute(
      'security',
      ['find-generic-password', '-a', user, '-s', from, '-w'],
      { timeout: 5_000, maxBuffer: 65536 },
    )
    secret = read.stdout.trim()
  } catch {
    return false
  }
  if (secret.length === 0) return false
  const hex = Buffer.from(secret, 'utf8').toString('hex')
  try {
    await securityStdin(`add-generic-password -U -a "${user}" -s "${to}" -X ${hex}\n`)
  } catch {
    return false
  }
  discardStagingKeychain(stagingDir)
  return true
}

// `security -i` reads the command from stdin, so the secret never reaches argv.
function securityStdin(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('security', ['-i'], { timeout: 5_000, maxBuffer: 65536 }, (error) =>
      error ? reject(error) : resolve(),
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(command)
  })
}

export function siblingStateDirectory(directory: string): string | undefined {
  if (directory === ':memory:') return undefined
  const base = basename(directory)
  const parent = dirname(directory)
  if (base === 'claude-sdk-web') return join(parent, 'claude-sdk-local')
  if (base === 'claude-sdk-local') return join(parent, 'claude-sdk-web')
  return undefined
}

export function mirrorProfileReady(
  directory: string,
  account: Account,
): 'mirrored' | 'absent' | 'locked' {
  const sibling = siblingStateDirectory(directory)
  if (sibling === undefined || !existsSync(join(sibling, 'state.sqlite'))) return 'absent'
  let store: StateStore
  try {
    store = new StateStore(sibling)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('STATE_IN_USE')) return 'locked'
    return 'absent'
  }
  try {
    let mirrored = false
    for (const row of store.list<Account>('accounts')) {
      if (row.profileRef !== account.profileRef) continue
      store.set('accounts', row.identity, {
        ...row,
        state: 'READY',
        verifiedAt: account.verifiedAt,
        models: account.models,
        ...(account.modelMetadata ? { modelMetadata: account.modelMetadata } : {}),
        ...(account.extraUsageOffConfirmedAt
          ? { extraUsageOffConfirmedAt: account.extraUsageOffConfirmedAt }
          : {}),
      })
      mirrored = true
    }
    return mirrored ? 'mirrored' : 'absent'
  } finally {
    store.close()
  }
}
