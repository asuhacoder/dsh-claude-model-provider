import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Compare canonical paths so package-manager bin links remain executable. */
export function isCliEntrypoint(
  moduleUrl: string,
  argvPath: string | undefined,
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (argvPath === undefined) return false
  try {
    return realpath(fileURLToPath(moduleUrl)) === realpath(argvPath)
  } catch {
    return false
  }
}
