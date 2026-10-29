import { createHash } from 'node:crypto'

const WATCHED = ['@deepseek-ai/dsh', '@anthropic-ai/claude-agent-sdk', 'dsh-plugin-subscriptions']
const LINE_PACKAGES = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']
const TAG_PREFERENCE = ['alpha', 'next', 'latest']
const GROUPS = ['dependencies', 'devDependencies', 'peerDependencies']

export function followedTag(distTags, version) {
  if (distTags == null || typeof version !== 'string') return null
  const matches = []
  for (const [tag, value] of Object.entries(distTags)) {
    if (value === version) matches.push(tag)
  }
  if (matches.length === 0) return null
  for (const tag of TAG_PREFERENCE) {
    if (matches.includes(tag)) return tag
  }
  return matches[0]
}

function selectFollowed(lockEntry, packument) {
  const tag = followedTag(lockEntry?.distTags, lockEntry?.version)
  if (tag == null) throw new Error('UNTRACKED_LINE')
  const liveTags = packument?.['dist-tags']
  const version = liveTags?.[tag]
  if (typeof version !== 'string') throw new Error('TAG_MISSING')
  const integrity = packument.versions?.[version]?.dist?.integrity
  if (typeof integrity !== 'string') throw new Error('INTEGRITY_MISSING')
  return { tag, version, integrity, distTags: { ...liveTags } }
}

function lineRanges(manifest) {
  const lines = {}
  for (const name of LINE_PACKAGES) {
    const spec = manifest?.dependencies?.[name] ?? manifest?.peerDependencies?.[name]
    if (typeof spec !== 'string' || spec.length === 0) throw new Error('LINE_RANGE_MISSING')
    lines[name] = spec
  }
  return lines
}

export function assessUpstream({ lock, packuments, defaultBranchSha }) {
  const packages = {}
  let changed = lock?.defaultBranchSha !== defaultBranchSha
  for (const name of WATCHED) {
    const selected = selectFollowed(lock?.packages?.[name], packuments[name])
    packages[name] = selected
    const previous = lock?.packages?.[name]
    if (previous?.version !== selected.version || previous?.integrity !== selected.integrity) changed = true
  }
  const dsh = packages['@deepseek-ai/dsh']
  const lines = lineRanges(packuments['@deepseek-ai/dsh']?.versions?.[dsh.version])
  return { changed, packages, lines, defaultBranchSha }
}

export function fingerprint(assessed) {
  const packages = {}
  for (const name of WATCHED) {
    const entry = assessed.packages[name]
    packages[name] = { tag: entry.tag, version: entry.version, integrity: entry.integrity }
  }
  return createHash('sha256')
    .update(JSON.stringify({ packages, lines: assessed.lines, defaultBranchSha: assessed.defaultBranchSha }))
    .digest('hex')
}

export function applyCandidate(manifest, tuple) {
  const dsh = tuple.packages['@deepseek-ai/dsh'].version
  const sdk = tuple.packages['@anthropic-ai/claude-agent-sdk'].version
  const lines = tuple.lines ?? {}
  const next = structuredClone(manifest)
  for (const group of GROUPS) {
    const deps = next[group]
    if (deps == null) continue
    for (const name of Object.keys(deps)) {
      if (name.startsWith('@deepseek-ai/dsh-')) deps[name] = dsh
      else if (name === '@anthropic-ai/claude-agent-sdk') deps[name] = sdk
      else if (typeof lines[name] === 'string') deps[name] = lines[name]
    }
  }
  return next
}
