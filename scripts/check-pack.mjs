import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const cache = mkdtempSync(join(tmpdir(), 'dsh-claude-pack-'))
let raw
try {
  raw = execFileSync(npmCommand, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache },
  })
} finally {
  rmSync(cache, { recursive: true, force: true })
}
const reports = JSON.parse(raw)
if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0]?.files)) {
  throw new Error('npm pack did not return one JSON file report')
}

const files = reports[0].files.map((file) => file.path).sort()
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const required = [
  'AUTHORS.md',
  'LICENSE',
  'README.md',
  'cordis.patch.yml',
  'lib/cli.js',
  'lib/doctor.js',
  'lib/doctor-runtime.js',
  'lib/index.d.ts',
  'lib/index.js',
  'lib/profile-verifier.js',
  'package.json',
]
const missing = required.filter((file) => !files.includes(file))
if (missing.length > 0) throw new Error(`Packed artifact is missing: ${missing.join(', ')}`)

const entries = manifest.files
if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string' || /[?*\\]|(^|\/)\.\.(\/|$)/.test(entry))) {
  throw new Error('Package files must be explicit files or directory prefixes')
}
const exact = new Set(['package.json', 'LICENSE', 'README.md', ...entries.filter((entry) => !entry.endsWith('/'))])
const directories = entries.filter((entry) => entry.endsWith('/'))
const unexpected = files.filter((file) => !exact.has(file) && !directories.some((directory) => file.startsWith(directory)))
if (unexpected.length > 0) {
  throw new Error(`Packed artifact contains unexpected files: ${unexpected.join(', ')}`)
}

const missingDeclared = entries.filter((entry) => entry.endsWith('/') ? !files.some((file) => file.startsWith(entry)) : !files.includes(entry))
if (missingDeclared.length > 0) throw new Error(`Declared package files are missing: ${missingDeclared.join(', ')}`)

const forbidden = files.filter((file) => /(^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.git(?:\/|$)|state\.sqlite(?:-|$)|handoff[^/]*|transcripts?(?:\/|$)|profiles?(?:\/|$))/.test(file))
if (forbidden.length > 0) throw new Error(`Packed artifact contains private files: ${forbidden.join(', ')}`)

console.log(`Checked npm package contents: ${files.length} intended file(s)`)
