import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [root = 'verified-release'] = process.argv.slice(2)
const expectedVersion = process.env.RELEASE_VERSION
const distTag = process.env.RELEASE_DIST_TAG
if (!expectedVersion || distTag !== 'next') throw new Error('RELEASE_INPUT_MISSING: RELEASE_VERSION and RELEASE_DIST_TAG=next are required')

const [major, minor, patch] = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim().split('.').map(Number)
if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
  throw new Error('NPM_TOO_OLD_FOR_TRUSTED_PUBLISHING: npm 11.5.1 or newer is required')
}

const report = JSON.parse(readFileSync(resolve(root, '.artifacts/release-dry-run.json'), 'utf8'))
if (report.version !== expectedVersion) throw new Error(`ARTIFACT_VERSION_MISMATCH: ${report.version} != ${expectedVersion}`)
const file = resolve(root, report.tarball)
if (createHash('sha256').update(readFileSync(file)).digest('hex') !== report.artifactSha256) throw new Error('ARTIFACT_MISMATCH')

execFileSync('npm', ['publish', file, '--provenance', '--tag', distTag, '--access', 'public', '--ignore-scripts'], {
  stdio: 'inherit',
})
