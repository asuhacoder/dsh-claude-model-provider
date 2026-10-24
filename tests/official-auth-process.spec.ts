import { execPath } from 'node:process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { officialStatus } from '../src/auth/official.js'
import { describeError, describeFailureDetail } from '../src/failure-evidence.js'

const status = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  orgId: 'fixture-org',
}
const limits = { timeoutMs: 400 }
const stderrText = 'hung'

function script(body: string): string {
  return `
const fs = require('fs')
const path = require('path')
const countFile = path.join(__dirname, 'count')
fs.writeFileSync(countFile, String(Number(fs.readFileSync(countFile, 'utf8')) + 1))
${body}
`
}

async function withClaude<T>(body: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'auth-status-'))
  writeFileSync(join(dir, 'auth'), script(body))
  writeFileSync(join(dir, 'count'), '0')
  const previous = process.cwd()
  process.chdir(dir)
  try {
    return await run(dir)
  } finally {
    process.chdir(previous)
    rmSync(dir, { recursive: true, force: true })
  }
}

function runs(dir: string): number {
  return Number(readFileSync(join(dir, 'count'), 'utf8'))
}

it('classifies a SIGTERM trap that exits 0 as an auth status timeout', async () => {
  await withClaude(
    `
process.stderr.write(${JSON.stringify(stderrText)})
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`,
    async (dir) => {
      const error = await officialStatus(execPath, 'default', limits).catch(
        (caught: unknown) => caught,
      )
      expect(error).toMatchObject({ code: 'AUTH_STATUS_TIMEOUT' })
      const detail = describeFailureDetail(error)
      expect(detail).toMatchObject({
        signal: 'SIGKILL',
        stderrBytes: Buffer.byteLength(stderrText),
      })
      expect(detail?.startedAt).toBeGreaterThan(1_700_000_000_000)
      expect(detail?.elapsedMs).toBeGreaterThanOrEqual(limits.timeoutMs)
      expect(detail?.elapsedMs).toBeLessThan(5_000)
      expect(JSON.stringify(detail)).not.toContain(stderrText)
      expect(JSON.stringify(describeError(error))).not.toContain(stderrText)
      expect(runs(dir)).toBe(2)
    },
  )
})

it('accepts a logged-in auth status document', async () => {
  await withClaude(
    `process.stdout.write(${JSON.stringify(JSON.stringify(status))})`,
    async (dir) => {
      await expect(officialStatus(execPath, 'default', limits)).resolves.toEqual(status)
      expect(runs(dir)).toBe(1)
    },
  )
})

it('rejects auth status output that is not a JSON object', async () => {
  await withClaude(
    `
process.stderr.write(${JSON.stringify(stderrText)})
process.stdout.write('not-json')
`,
    async (dir) => {
      const error = await officialStatus(execPath, 'default', limits).catch(
        (caught: unknown) => caught,
      )
      expect(error).toMatchObject({ code: 'AUTH_STATUS_INVALID_OUTPUT' })
      const detail = describeFailureDetail(error)
      expect(detail).toMatchObject({
        stdoutBytes: Buffer.byteLength('not-json'),
        stderrBytes: Buffer.byteLength(stderrText),
      })
      expect(detail?.startedAt).toBeGreaterThan(1_700_000_000_000)
      expect(detail?.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(detail?.elapsedMs).toBeLessThan(5_000)
      expect(JSON.stringify(detail)).not.toContain(stderrText)
      expect(JSON.stringify(describeError(error))).not.toContain(stderrText)
      expect(runs(dir)).toBe(1)
    },
  )
})

it('retries a timed out auth status and keeps the second result', async () => {
  await withClaude(
    `
const attempt = Number(fs.readFileSync(countFile, 'utf8'))
if (attempt === 1) {
  process.stderr.write(${JSON.stringify(stderrText)})
  process.on('SIGTERM', () => process.exit(0))
  setInterval(() => {}, 1000)
} else {
  process.stdout.write(${JSON.stringify(JSON.stringify(status))})
}
`,
    async (dir) => {
      await expect(officialStatus(execPath, 'default', limits)).resolves.toEqual(status)
      expect(runs(dir)).toBe(2)
    },
  )
})
