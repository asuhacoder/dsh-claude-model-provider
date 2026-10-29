import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { assessUpstream, fingerprint } from './upstream-line.mjs'

const names = ['@deepseek-ai/dsh', '@anthropic-ai/claude-agent-sdk', 'dsh-plugin-subscriptions']

async function registry(name) {
  const res = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name))
  if (!res.ok) throw new Error('REGISTRY_UNAVAILABLE')
  return res.json()
}

const packuments = {}
for (const name of names) packuments[name] = await registry(name)

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
const headers = {
  'User-Agent': 'dsh-session-provider-compat',
  ...(token ? { Authorization: 'Bearer ' + token } : {}),
}
async function github(path) {
  const response = await fetch('https://api.github.com/' + path, {
    headers,
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('GITHUB_METADATA_HTTP_' + response.status)
  return response.json()
}
const repo = await github('repos/deepseek-ai/deepseek-harness')
const ref = await github('repos/deepseek-ai/deepseek-harness/commits/' + encodeURIComponent(repo.default_branch))
if (!/^[0-9a-f]{40}$/.test(ref.sha ?? '')) throw new Error('UPSTREAM_SHA_UNAVAILABLE')

let lock
try {
  lock = JSON.parse(readFileSync('compatibility.lock.json', 'utf8'))
} catch {
  lock = undefined
}
const assessed = assessUpstream({ lock, packuments, defaultBranchSha: ref.sha })
const result = {
  schema: 1,
  observedAt: new Date().toISOString(),
  packages: assessed.packages,
  lines: assessed.lines,
  defaultBranch: repo.default_branch,
  defaultBranchSha: ref.sha,
  changed: assessed.changed,
  fingerprint: fingerprint(assessed),
}
mkdirSync('.artifacts', { recursive: true })
writeFileSync('.artifacts/upstream.json', JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, 'changed=' + result.changed + '\ntuple=' + JSON.stringify(result) + '\n')
}
