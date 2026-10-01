import { createHash, verify } from 'node:crypto'
export function classifyPatch(paths, patch) {
  if (paths.some((p) => !/^src\/dsh\/[^.][A-Za-z0-9/_-]*\.ts$/.test(p))) return 'HUMAN_REVIEW'
  if (
    /(?:https?:|fetch\(|import\(|eval\(|child_process|process\.|permission|auth|retry|stream|tool|history|quota|routing|require\()/i.test(
      patch,
    )
  )
    return 'HUMAN_REVIEW'
  // No semantic safety proof is inferred merely from a pathname.
  return 'HUMAN_REVIEW'
}
export function verifyEvidence(bytes, signature, publicKey, expected) {
  let data
  try {
    if (!verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, 'base64'))) return false
    data = JSON.parse(bytes)
  } catch {
    return false
  }
  return (
    data.candidateSha === expected.candidateSha &&
    data.artifactSha256 === expected.artifactSha256 &&
    data.policySha256 === expected.policySha256 &&
    data.status === 'PASSED' &&
    data.levels.includes('L1') &&
    data.levels.includes('L2')
  )
}
export function jobAllowed(job, now = Date.now()) {
  return (
    job?.schema === 1 &&
    /^[0-9a-f]{40}$/.test(job.baseSha ?? '') &&
    [
      'deepseek-ai/deepseek-harness',
      'anthropics/claude-agent-sdk-typescript',
      'V1ki/dsh-plugin-subscriptions',
    ].includes(job.upstreamRepo) &&
    Number.isInteger(job.attempts) &&
    job.attempts >= 0 &&
    job.attempts < 3 &&
    Number.isFinite(job.deadline) &&
    job.deadline > now &&
    job.deadline <= now + 3600000 &&
    typeof job.fingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(job.fingerprint)
  )
}
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
