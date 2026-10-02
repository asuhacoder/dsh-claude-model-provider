import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultStateDirectory(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'claude-sdk-local')
}
