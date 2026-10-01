import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import {
  repairCycle,
  createEvidence,
  sha256,
  publisherRequest,
  promotionDecision,
} from './pipeline.mjs'
const root = mkdtempSync(join(tmpdir(), 'dsh-repair-e2e-')),
  worker = join(root, 'worker'),
  verifier = join(root, 'verifier'),
  keys = generateKeyPairSync('ed25519')
const cleanEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: root,
  USERPROFILE: root,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(root, 'absent'),
}
const run = (cmd, args, cwd = worker) =>
  execFileSync(cmd, args, {
    cwd,
    env: cleanEnv,
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
try {
  for (const dir of [worker, verifier]) mkdirSync(join(dir, 'src/dsh'), { recursive: true })
  const broken = 'export const adapt = (send, text) => send(text)\n',
    fixed = 'export const adapt = (send, text) => send({text})\n'
  writeFileSync(join(worker, 'src/dsh/adapter.ts'), broken)
  run('git', ['init', '-q'])
  run('git', ['add', '.'])
  run('git', [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@invalid',
    'commit',
    '-qm',
    'base',
  ])
  const baseSha = run('git', ['rev-parse', 'HEAD']),
    fingerprint = sha256('upstream signature changed'),
    registry = {},
    events = []
  const trustedTest = `import assert from 'node:assert/strict';import {adapt} from './src/dsh/adapter.ts';assert.equal(adapt(({text})=>text.toUpperCase(),'fixture'),'FIXTURE');`
  writeFileSync(join(verifier, 'check.mjs'), trustedTest)
  const verifyCode = (code) => {
    writeFileSync(join(verifier, 'src/dsh/adapter.ts'), code)
    return (
      spawnSync(process.execPath, ['check.mjs'], { cwd: verifier, env: cleanEnv, timeout: 10000 })
        .status === 0
    )
  }
  const services = {
    now: Date.now,
    verifierPublicKey: keys.publicKey,
    compatibility: async () => ({
      status: verifyCode(broken) ? 'PASSED' : 'FAILED',
      sanitizedFailure: 'upstream now requires {text}',
    }),
    worker: async () => {
      events.push('independent-worker')
      run(process.execPath, [
        '-e',
        `require('node:fs').writeFileSync('src/dsh/adapter.ts',${JSON.stringify(fixed)})`,
      ])
      const patch = run('git', ['diff']) + '\n'
      run('git', ['add', '.'])
      run('git', [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@invalid',
        'commit',
        '-qm',
        'candidate',
      ])
      return { sha: run('git', ['rev-parse', 'HEAD']), paths: ['src/dsh/adapter.ts'], patch }
    },
    verifier: async (request) => {
      events.push('protected-verifier')
      const code = run('git', ['show', request.candidateSha + ':src/dsh/adapter.ts'])
      const status = verifyCode(code) ? 'PASSED' : 'FAILED',
        artifactSha256 = sha256(code)
      if (readFileSync(join(verifier, 'check.mjs'), 'utf8') !== trustedTest)
        throw new Error('TRUSTED_TEST_CHANGED')
      return {
        artifactSha256,
        evidence: createEvidence(
          {
            status,
            levels: ['L1'],
            baseSha,
            candidateSha: request.candidateSha,
            artifactSha256,
            verifierSourceSha: baseSha,
          },
          keys.privateKey,
        ),
      }
    },
    publisher: async (input) => {
      events.push('publisher-dry-run')
      publisherRequest(input, 'asuhacoder/dsh-claude-model-provider')
      return { url: 'local:reviewable-fixture-pr' }
    },
  }
  const result = await repairCycle(
    { schema: 1, baseSha, fingerprint, deadline: Date.now() + 60000 },
    services,
    registry,
  )
  if (result.status !== 'PR_OPEN') throw new Error('PIPELINE_FAILED')
  const report = {
    status: 'PASSED',
    scope: 'local separated-process fixture; no real PR, no production isolation claim',
    upstreamBreakDetected: true,
    candidateFixed: true,
    protectedVerifierPassed: true,
    credentialEnvironmentStripped: true,
    realGitCandidate: true,
    events,
    attempts: result.attempts,
    modelCalls: 0,
    externalPrerequisite:
      'Private isolated worker/verifier deployment remains required for untrusted production patches',
  }
  mkdirSync('.artifacts', { recursive: true })
  writeFileSync('.artifacts/repair-fixture-e2e.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} finally {
  rmSync(root, { recursive: true, force: true })
}
