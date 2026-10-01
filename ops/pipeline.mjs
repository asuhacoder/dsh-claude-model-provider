import { createHash, sign, verify } from 'node:crypto'
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const RULES = Object.freeze({
  schema: 1,
  maxAttempts: 3,
  maxMs: 3600000,
  cooldownMs: 21600000,
  maxPatchBytes: 262144,
  automaticMerge: false,
  protected: [
    'tests/',
    'ops/',
    '.github/',
    'scripts/',
    'package.json',
    'pnpm-lock.yaml',
    'vitest.config.ts',
    'src/auth/',
    'src/routing/',
    'src/sessions/',
    'src/tool',
    'src/process',
    'src/bridge',
    'src/storage/',
  ],
})
export const policySha256 = sha256(JSON.stringify(RULES))
export function assessCandidate(candidate) {
  if (
    !candidate ||
    typeof candidate.patch !== 'string' ||
    Buffer.byteLength(candidate.patch) > RULES.maxPatchBytes
  )
    return { allowed: false, reason: 'INVALID_PATCH' }
  if (
    !/^[a-f0-9]{40}$/.test(candidate.sha ?? '') ||
    !Array.isArray(candidate.paths) ||
    !candidate.paths.length
  )
    return { allowed: false, reason: 'INVALID_CANDIDATE' }
  if (
    candidate.paths.some(
      (p) =>
        typeof p !== 'string' ||
        !/^src\/[\w/-]+\.ts$/.test(p) ||
        p.split('/').includes('..') ||
        RULES.protected.some((x) => p.startsWith(x)),
    )
  )
    return { allowed: false, reason: 'PROTECTED_CHANGE' }
  const declared = [...new Set(candidate.paths)].sort()
  const actual = [...candidate.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]).sort()
  if (
    JSON.stringify(actual) !== JSON.stringify(declared) ||
    /^(?:deleted file|new file mode 120000|GIT binary patch|rename |copy )/m.test(candidate.patch)
  )
    return { allowed: false, reason: 'PATCH_MANIFEST_MISMATCH' }
  const added = candidate.patch
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n')
  if (
    /https?:|\bfetch\s*\(|child_process|\beval\s*\(|\bprocess\s*[.[]|\brequire\s*\(|\bimport\s*\(|\.github|assert|PASS(?:ED)?\b|secret|token|credential/i.test(
      added,
    )
  )
    return { allowed: false, reason: 'SENSITIVE_CHANGE' }
  return {
    allowed: true,
    decision: 'HUMAN_REVIEW',
    reason: 'independent-tests-and-maintainer-review-required',
  }
}
export function createEvidence(payload, privateKey) {
  const bytes = JSON.stringify({ ...payload, policySha256 })
  return { bytes, signature: sign(null, Buffer.from(bytes), privateKey).toString('base64') }
}
export function checkEvidence(envelope, publicKey, expected) {
  try {
    if (
      !verify(
        null,
        Buffer.from(envelope.bytes),
        publicKey,
        Buffer.from(envelope.signature, 'base64'),
      )
    )
      return false
    const e = JSON.parse(envelope.bytes)
    return (
      e.policySha256 === policySha256 &&
      e.candidateSha === expected.candidateSha &&
      e.baseSha === expected.baseSha &&
      e.artifactSha256 === expected.artifactSha256 &&
      e.status === 'PASSED' &&
      e.levels.includes('L1') &&
      e.verifierSourceSha === expected.baseSha
    )
  } catch {
    return false
  }
}
/** Worker, verifier and publisher are injected separate processes/services, never candidate imports. */
export async function repairCycle(job, services, registry, now = Date.now()) {
  const valid =
    job?.schema === 1 &&
    /^[a-f0-9]{40}$/.test(job.baseSha ?? '') &&
    /^[a-f0-9]{64}$/.test(job.fingerprint ?? '') &&
    job.deadline > now &&
    job.deadline <= now + RULES.maxMs
  if (!valid) return { status: 'BLOCKED', reason: 'INVALID_JOB' }
  const prior = registry[job.fingerprint]
  if (prior && (prior.status === 'PR_OPEN' || now - prior.at < RULES.cooldownMs))
    return { status: 'SKIPPED', reason: 'DEDUP_OR_COOLDOWN' }
  registry[job.fingerprint] = { status: 'RUNNING', at: now, attempts: 0 }
  try {
    const baseline = await services.compatibility(job)
    if (baseline.status === 'PASSED') {
      registry[job.fingerprint].status = 'COMPATIBLE'
      return { status: 'COMPATIBLE', attempts: 0 }
    }
    for (let attempt = 1; attempt <= RULES.maxAttempts; attempt++) {
      registry[job.fingerprint].attempts = attempt
      if (services.now() > job.deadline)
        return { status: 'BLOCKED', reason: 'DEADLINE', attempts: attempt - 1 }
      const candidate = await services.worker({
        ...job,
        attempt,
        failure: baseline.sanitizedFailure,
      })
      const policy = assessCandidate(candidate)
      if (!policy.allowed)
        return { status: 'HUMAN_REVIEW', reason: policy.reason, attempts: attempt }
      const verified = await services.verifier({
        baseSha: job.baseSha,
        candidateSha: candidate.sha,
        patch: candidate.patch,
        policySha256,
      })
      if (
        !checkEvidence(verified.evidence, services.verifierPublicKey, {
          baseSha: job.baseSha,
          candidateSha: candidate.sha,
          artifactSha256: verified.artifactSha256,
        })
      )
        continue
      const result = await services.publisher({
        branch: 'bot/compat-' + job.fingerprint.slice(0, 16),
        baseSha: job.baseSha,
        candidate,
        verified,
        draft: true,
        autoMerge: false,
      })
      registry[job.fingerprint].status = 'PR_OPEN'
      return { status: 'PR_OPEN', attempts: attempt, pr: result.url, autoMerge: false }
    }
    return { status: 'HUMAN_REVIEW', reason: 'ATTEMPT_LIMIT', attempts: RULES.maxAttempts }
  } finally {
    if (registry[job.fingerprint].status === 'RUNNING')
      registry[job.fingerprint].status = 'COOLDOWN'
  }
}
export function promotionDecision({ evidence, publicKey, expected, approved, canary }) {
  if (!checkEvidence(evidence, publicKey, expected))
    return { action: 'BLOCK', reason: 'INVALID_EVIDENCE' }
  const e = JSON.parse(evidence.bytes)
  if (!e.levels.includes('L2')) return { action: 'BLOCK', reason: 'LIVE_VERIFICATION_REQUIRED' }
  if (!approved) return { action: 'HOLD_NEXT', reason: 'MAINTAINER_APPROVAL_REQUIRED' }
  if (
    !canary ||
    canary.completed < 3 ||
    canary.failures !== 0 ||
    canary.duplicateTools !== 0 ||
    canary.billingAnomalies !== 0
  )
    return { action: 'ROLLBACK', reason: 'CANARY_FAILED_OR_INCOMPLETE' }
  return { action: 'PROMOTE', reason: 'SIGNED_TESTS_AND_CANARY_PASSED' }
}
export function publisherRequest(input, expectedRepository) {
  if (
    expectedRepository !== 'asuhacoder/dsh-claude-model-provider' ||
    !/^bot\/compat-[a-f0-9]{16}$/.test(input.branch) ||
    input.draft !== true ||
    input.autoMerge !== false
  )
    throw new Error('PUBLISHER_SCOPE_REJECTED')
  if (!assessCandidate(input.candidate).allowed) throw new Error('PUBLISHER_PATCH_REJECTED')
  return {
    title: 'Compatibility repair candidate',
    head: input.branch,
    base: 'main',
    draft: true,
    body: `Compatibility candidate from pinned base ${input.baseSha}.\n\nIndependent verifier evidence is bound to candidate ${input.candidate.sha}. This changes adapter behavior and requires human review.\n\nArtifact SHA-256: ${input.verified.artifactSha256}`,
  }
}
