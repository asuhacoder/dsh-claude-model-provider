import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { applyCandidate } from './upstream-line.mjs'

const input = JSON.parse(process.env.CANDIDATE_TUPLE || readFileSync('.artifacts/upstream.json', 'utf8'))
const names = ['@deepseek-ai/dsh', '@anthropic-ai/claude-agent-sdk', 'dsh-plugin-subscriptions']
const version = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/
const integrity = /^sha512-[A-Za-z0-9+/=]+$/
const range = /^[~^]?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/
for (const name of names) {
  const pinned = input.packages?.[name]
  if (!pinned || !version.test(pinned.version) || !integrity.test(pinned.integrity)) {
    throw new Error('INVALID_PINNED_TUPLE')
  }
}
for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
  if (!range.test(input.lines?.[name] ?? '')) throw new Error('INVALID_PINNED_TUPLE')
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
writeFileSync('package.json', JSON.stringify(applyCandidate(pkg, input), null, 2) + '\n')
mkdirSync('.artifacts', { recursive: true })
writeFileSync('.artifacts/candidate-tuple.json', JSON.stringify(input, null, 2) + '\n')
