import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { classifyPatch, verifyEvidence, jobAllowed } from './policy.mjs'
test('protected tests, workflows, auth and executable side effects require a human', () => {
  for (const path of [
    'tests/x.spec.ts',
    '.github/workflows/ci.yml',
    'src/auth/official.ts',
    'src/dsh/type.ts',
  ])
    assert.equal(classifyPatch([path], 'fetch("https://untrusted.invalid")'), 'HUMAN_REVIEW')
})
test('candidate cannot self-assert PASS or reuse another artifact', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const expected = {
    candidateSha: 'a'.repeat(40),
    artifactSha256: 'b'.repeat(64),
    policySha256: 'c'.repeat(64),
  }
  const bytes = JSON.stringify({ ...expected, status: 'PASSED', levels: ['L1', 'L2'] })
  const signature = sign(null, Buffer.from(bytes), privateKey).toString('base64')
  assert(verifyEvidence(bytes, signature, publicKey, expected))
  assert(
    !verifyEvidence(bytes, signature, publicKey, { ...expected, candidateSha: 'd'.repeat(40) }),
  )
  assert(!verifyEvidence(bytes, 'fake-PASS', publicKey, expected))
})
test('repair jobs have a fixed allowlist, bounded budget and deadline', () => {
  const base = {
    schema: 1,
    baseSha: 'a'.repeat(40),
    fingerprint: 'b'.repeat(64),
    upstreamRepo: 'deepseek-ai/deepseek-harness',
    attempts: 0,
    deadline: 1000,
  }
  assert(jobAllowed(base, 0))
  assert(!jobAllowed({ ...base, attempts: 3 }, 0))
  assert(!jobAllowed({ ...base, upstreamRepo: 'attacker/prompt' }, 0))
  assert(!jobAllowed(base, 2000))
})
