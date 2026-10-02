import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { defaultStateDirectory } from './storage/paths.js'
import { RouteBlocked } from './routing/types.js'

const execute = promisify(execFile)
interface StateResolution {
  home?: string
  cwd?: string
  modulePath?: string
  dump?: (profile: string) => Promise<string>
}

/** Resolve the composed DSH profile, never guess by merging a subset of YAML layers. */
export async function resolveCliState(
  args: readonly string[],
  options: StateResolution = {},
): Promise<string> {
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    if (index < 0) return undefined
    const next = args[index + 1]
    if (!next || next.startsWith('--')) throw new RouteBlocked('CLI_OPTION_VALUE_REQUIRED')
    return next
  }
  const explicit = value('--state')
  if (explicit !== undefined) return explicit
  const root = join(options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles')
  const profileFor = (path: string) => {
    const parts = relative(root, path).split(sep)
    return parts.length >= 1 && parts[0] && parts[0] !== '..' && !isAbsolute(parts[0])
      ? parts[0]
      : undefined
  }
  const profile =
    value('--dsh-profile') ??
    profileFor(options.cwd ?? process.cwd()) ??
    profileFor(options.modulePath ?? fileURLToPath(import.meta.url))
  if (profile === undefined) return defaultStateDirectory()
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new RouteBlocked('INVALID_DSH_PROFILE')
  try {
    const source = await (
      options.dump ??
      (async (name) =>
        (
          await execute('dsh', ['--profile', name, '--dump-config'], {
            timeout: 15000,
            maxBuffer: 8 * 1024 * 1024,
          })
        ).stdout)
    )(profile)
    const doc = parseDocument(source, { strict: true, uniqueKeys: true })
    if (doc.errors.length) throw new Error('invalid profile')
    const rows: unknown = doc.toJS({ maxAliasCount: 0 })
    if (!Array.isArray(rows)) throw new Error('invalid profile')
    const matches = rows.filter(
      (row) => row && typeof row === 'object' && row.id === 'llm-claude-sdk-local',
    )
    if (matches.length !== 1) throw new Error('missing or ambiguous provider')
    const state: unknown = matches[0].config?.stateDirectory
    if (state === undefined || state === '') return defaultStateDirectory()
    if (typeof state !== 'string' || !isAbsolute(state)) throw new Error('invalid state directory')
    return state
  } catch {
    // No fallback to another database on an ambiguous/failed profile lookup.
    throw new RouteBlocked('PROFILE_STATE_UNRESOLVED')
  }
}
