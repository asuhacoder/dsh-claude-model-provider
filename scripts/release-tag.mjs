import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

export class ReleaseTagError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`)
    this.code = code
  }
}

export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const heading = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start < 0) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  const body = (end < 0 ? rest : rest.slice(0, end)).join('\n').trim()
  return body.length > 0 ? body : undefined
}

export function assessReleaseTag({ ref, version, changelog, publishedVersions }) {
  const match = SEMVER.exec(version)
  if (!match) throw new ReleaseTagError('INVALID_VERSION', `package.json version ${JSON.stringify(version)} is not semver`)
  const expected = `refs/tags/v${version}`
  if (ref !== expected) throw new ReleaseTagError('TAG_VERSION_MISMATCH', `ref ${ref} does not match ${expected}`)
  if (match[4] === undefined) {
    throw new ReleaseTagError('STABLE_RELEASE_IS_MANUAL', `${version} has no prerelease identifier; latest promotion stays manual`)
  }
  if (publishedVersions.includes(version)) {
    throw new ReleaseTagError('VERSION_ALREADY_PUBLISHED', `${version} already exists on npm and versions are immutable`)
  }
  const notes = changelogSection(changelog, version)
  if (notes === undefined) throw new ReleaseTagError('CHANGELOG_ENTRY_MISSING', `CHANGELOG.md has no non-empty "## ${version}" section`)
  return { version, distTag: 'next', notes }
}

function publishedVersionsOf(name) {
  try {
    const raw = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (/E404/.test(output)) return []
    throw error
  }
}

function assertOnMain() {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { stdio: 'ignore' })
  } catch {
    throw new ReleaseTagError('TAG_NOT_ON_MAIN', 'the tagged commit is not contained in origin/main')
  }
}

function main() {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  const result = assessReleaseTag({
    ref: process.env.GITHUB_REF ?? '',
    version: manifest.version,
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    publishedVersions: publishedVersionsOf(manifest.name),
  })
  assertOnMain()
  mkdirSync('.artifacts', { recursive: true })
  writeFileSync('.artifacts/release-notes.md', `${result.notes}\n`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ndist-tag=${result.distTag}\n`)
  }
  console.log(JSON.stringify({ status: 'PASSED', version: result.version, distTag: result.distTag }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
