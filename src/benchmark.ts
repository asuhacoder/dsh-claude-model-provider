import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

export const BENCHMARK_SCHEMA_VERSION = 1
export const BENCHMARK_MIN_LATENCY_SAMPLES = 5
export const BENCHMARK_P1_LATENCY_OVERHEAD_PERCENT = 20
export const BENCHMARK_P1_SUCCESS_LOSS_POINTS = 5

export const BENCHMARK_LANES = ['direct', 'dsh'] as const
export const BENCHMARK_PHASES = ['warmup', 'measured'] as const
export const BENCHMARK_SEVERITIES = ['P0', 'P1', 'P2'] as const

export type BenchmarkLane = (typeof BENCHMARK_LANES)[number]
export type BenchmarkPhase = (typeof BENCHMARK_PHASES)[number]
export type BenchmarkSeverity = (typeof BENCHMARK_SEVERITIES)[number]

export interface BenchmarkUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens?: number
  readonly estimatedCostUsd?: number
}

export interface BenchmarkOutputDigest {
  readonly algorithm: 'sha256'
  readonly digest: string
  readonly bytes: number
}

export interface BenchmarkCorrectness {
  readonly pass: boolean
  readonly checks: readonly string[]
  readonly failedChecks: readonly string[]
}

export interface BenchmarkInvariants {
  readonly cleanup: boolean
  readonly toolCorrelation: boolean
  readonly policy: boolean
  readonly transcript: boolean
  readonly redaction: boolean
}

export interface BenchmarkObservation {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION
  readonly runId: string
  readonly environmentId: string
  readonly scenarioId: string
  readonly category: string
  readonly core: boolean
  readonly lane: BenchmarkLane
  readonly phase: BenchmarkPhase
  readonly repetition: number
  readonly model: string
  readonly effort: string
  readonly success: boolean
  readonly correctness: BenchmarkCorrectness
  readonly output: BenchmarkOutputDigest
  readonly expectedOutput?: BenchmarkOutputDigest
  readonly durationMs: number
  readonly firstTokenMs?: number
  readonly firstToolRequestMs?: number
  readonly cancellationMs?: number
  readonly cleanupMs: number
  readonly textDeltaCount: number
  readonly reasoningDeltaCount: number
  readonly toolCallCount: number
  readonly toolResultCount: number
  readonly duplicateBlockCount: number
  readonly missingBlockCount: number
  readonly childProcessesLeaked: number
  readonly usage?: BenchmarkUsage
  readonly invariants: BenchmarkInvariants
  readonly failureCode?: string
}

export interface Distribution {
  readonly count: number
  readonly min: number
  readonly median: number
  readonly p95: number
  readonly max: number
}

export interface LaneSummary {
  readonly lane: BenchmarkLane
  readonly attempts: number
  readonly successes: number
  readonly successRate: number
  readonly correctnessRate: number
  readonly durationMs?: Distribution
  readonly firstTokenMs?: Distribution
  readonly cleanupMs?: Distribution
}

export interface ScenarioSummary {
  readonly scenarioId: string
  readonly category: string
  readonly core: boolean
  readonly direct: LaneSummary
  readonly dsh: LaneSummary
  readonly pairedSamples: number
  readonly latencyOverheadPercent?: number
  readonly successLossPoints: number
  readonly outputAgreementRate?: number
  readonly comparable: boolean
}

export interface BenchmarkWeakness {
  readonly severity: BenchmarkSeverity
  readonly code: string
  readonly scenarioId?: string
  readonly summary: string
  readonly evidence: string
}

export interface BenchmarkAnalysis {
  readonly scenarios: readonly ScenarioSummary[]
  readonly weaknesses: readonly BenchmarkWeakness[]
  readonly measuredObservations: number
  readonly comparableScenarios: number
  readonly complete: boolean
}

export interface BenchmarkReportEnvironment {
  readonly generatedAt: string
  readonly commit: string
  readonly branch: string
  readonly dirty: boolean
  readonly node: string
  readonly platform: string
  readonly arch: string
  readonly dsh: string
  readonly sdk: string
  readonly claudeCode: string
  readonly model: string
  readonly effort: string
  readonly warmups: number
  readonly repetitions: number
  readonly resultsPath: string
}

const SHA256 = /^[0-9a-f]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be finite and non-negative`)
  return value
}

function safeCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function safeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${label} has an invalid shape`)
  return value
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100
}

function rounded(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function digestBenchmarkText(text: string): BenchmarkOutputDigest {
  return Object.freeze({
    algorithm: 'sha256',
    digest: createHash('sha256').update(text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
  })
}

export function benchmarkTerminalSuccess(
  failureCode: string | undefined,
  correctnessPass: boolean,
): boolean {
  return failureCode === undefined && correctnessPass
}

export function benchmarkTranscriptInvariant(
  duplicateBlockCount: number,
  missingBlockCount: number,
): boolean {
  safeCount(duplicateBlockCount, 'duplicateBlockCount')
  safeCount(missingBlockCount, 'missingBlockCount')
  return duplicateBlockCount === 0 && missingBlockCount === 0
}

export function distribution(values: readonly number[]): Distribution | undefined {
  if (values.length === 0) return undefined
  const sorted = values.map((value) => finiteNonNegative(value, 'sample')).sort((a, b) => a - b)
  const medianIndex = Math.floor(sorted.length / 2)
  const lower = sorted[medianIndex - 1]
  const upper = sorted[medianIndex]
  if (upper === undefined) throw new Error('distribution unexpectedly has no median')
  const median = sorted.length % 2 === 0 && lower !== undefined ? (lower + upper) / 2 : upper
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1)
  return Object.freeze({
    count: sorted.length,
    min: sorted[0]!,
    median: rounded(median),
    p95: rounded(sorted[p95Index]!),
    max: sorted.at(-1)!,
  })
}

export function validateBenchmarkObservation(
  observation: BenchmarkObservation,
): BenchmarkObservation {
  if (observation.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new Error('benchmark observation schema version is unsupported')
  }
  safeId(observation.runId, 'runId')
  safeId(observation.environmentId, 'environmentId')
  safeId(observation.scenarioId, 'scenarioId')
  safeId(observation.category, 'category')
  if (!(BENCHMARK_LANES as readonly string[]).includes(observation.lane)) {
    throw new Error('benchmark lane is unsupported')
  }
  if (!(BENCHMARK_PHASES as readonly string[]).includes(observation.phase)) {
    throw new Error('benchmark phase is unsupported')
  }
  if (typeof observation.success !== 'boolean' || typeof observation.core !== 'boolean') {
    throw new Error('benchmark success and core flags must be boolean')
  }
  if (!SAFE_MODEL.test(observation.model) || !SAFE_ID.test(observation.effort)) {
    throw new Error('benchmark model or effort has an invalid shape')
  }
  if (
    typeof observation.correctness.pass !== 'boolean' ||
    !Array.isArray(observation.correctness.checks) ||
    !Array.isArray(observation.correctness.failedChecks)
  ) {
    throw new Error('benchmark correctness evidence is invalid')
  }
  safeCount(observation.repetition, 'repetition')
  finiteNonNegative(observation.durationMs, 'durationMs')
  finiteNonNegative(observation.cleanupMs, 'cleanupMs')
  for (const [label, value] of [
    ['firstTokenMs', observation.firstTokenMs],
    ['firstToolRequestMs', observation.firstToolRequestMs],
    ['cancellationMs', observation.cancellationMs],
  ] as const) {
    if (value !== undefined) finiteNonNegative(value, label)
  }
  for (const [label, value] of [
    ['textDeltaCount', observation.textDeltaCount],
    ['reasoningDeltaCount', observation.reasoningDeltaCount],
    ['toolCallCount', observation.toolCallCount],
    ['toolResultCount', observation.toolResultCount],
    ['duplicateBlockCount', observation.duplicateBlockCount],
    ['missingBlockCount', observation.missingBlockCount],
    ['childProcessesLeaked', observation.childProcessesLeaked],
  ] as const) {
    safeCount(value, label)
  }
  if (observation.output.algorithm !== 'sha256' || !SHA256.test(observation.output.digest)) {
    throw new Error('output digest is invalid')
  }
  safeCount(observation.output.bytes, 'output bytes')
  if (observation.expectedOutput !== undefined) {
    if (
      observation.expectedOutput.algorithm !== 'sha256' ||
      !SHA256.test(observation.expectedOutput.digest)
    )
      throw new Error('expected digest is invalid')
    safeCount(observation.expectedOutput.bytes, 'expected output bytes')
  }
  if (observation.failureCode !== undefined) safeId(observation.failureCode, 'failureCode')
  if (observation.usage !== undefined) {
    for (const [label, value] of [
      ['usage.inputTokens', observation.usage.inputTokens],
      ['usage.outputTokens', observation.usage.outputTokens],
      ['usage.cacheReadTokens', observation.usage.cacheReadTokens],
      ['usage.cacheWriteTokens', observation.usage.cacheWriteTokens],
      ['usage.reasoningTokens', observation.usage.reasoningTokens],
    ] as const) {
      if (value !== undefined) safeCount(value, label)
    }
    if (observation.usage.estimatedCostUsd !== undefined) {
      finiteNonNegative(observation.usage.estimatedCostUsd, 'usage.estimatedCostUsd')
    }
  }
  if (
    Object.values(observation.invariants).length !== 5 ||
    Object.values(observation.invariants).some((value) => typeof value !== 'boolean')
  ) {
    throw new Error('benchmark invariants are invalid')
  }
  if (observation.success && !observation.correctness.pass) {
    throw new Error('successful benchmark observations must pass correctness checks')
  }
  return observation
}

function laneSummary(
  observations: readonly BenchmarkObservation[],
  lane: BenchmarkLane,
): LaneSummary {
  const entries = observations.filter((entry) => entry.lane === lane)
  const successful = entries.filter((entry) => entry.success)
  const durationMs = distribution(successful.map((entry) => entry.durationMs))
  const firstTokenMs = distribution(successful.flatMap((entry) => entry.firstTokenMs ?? []))
  const cleanupMs = distribution(entries.map((entry) => entry.cleanupMs))
  return Object.freeze({
    lane,
    attempts: entries.length,
    successes: successful.length,
    successRate: rounded(rate(successful.length, entries.length)),
    correctnessRate: rounded(
      rate(entries.filter((entry) => entry.correctness.pass).length, entries.length),
    ),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    ...(cleanupMs === undefined ? {} : { cleanupMs }),
  })
}

function pairKey(observation: BenchmarkObservation): string {
  return `${observation.environmentId}\u0000${observation.scenarioId}\u0000${String(observation.repetition)}`
}

function pairedEntries(
  observations: readonly BenchmarkObservation[],
): readonly (readonly [BenchmarkObservation, BenchmarkObservation])[] {
  const pairs = new Map<string, Partial<Record<BenchmarkLane, BenchmarkObservation>>>()
  for (const observation of observations) {
    const key = pairKey(observation)
    const pair = pairs.get(key) ?? {}
    if (pair[observation.lane] !== undefined) {
      throw new Error(`duplicate ${observation.lane} observation for ${observation.scenarioId}`)
    }
    pair[observation.lane] = observation
    pairs.set(key, pair)
  }
  return [...pairs.values()].flatMap((pair) =>
    pair.direct === undefined || pair.dsh === undefined ? [] : [[pair.direct, pair.dsh] as const],
  )
}

function scenarioSummary(observations: readonly BenchmarkObservation[]): ScenarioSummary {
  const first = observations[0]
  if (first === undefined) throw new Error('cannot summarize an empty scenario')
  const direct = laneSummary(observations, 'direct')
  const dsh = laneSummary(observations, 'dsh')
  const pairs = pairedEntries(observations)
  const successfulPairs = pairs.filter(([left, right]) => left.success && right.success)
  const directDurations = successfulPairs.map(([entry]) => entry.durationMs)
  const dshDurations = successfulPairs.map(([, entry]) => entry.durationMs)
  const directDistribution = distribution(directDurations)
  const dshDistribution = distribution(dshDurations)
  const overhead =
    directDistribution === undefined ||
    dshDistribution === undefined ||
    directDistribution.median === 0
      ? undefined
      : rounded(
          ((dshDistribution.median - directDistribution.median) / directDistribution.median) * 100,
        )
  const agreement =
    successfulPairs.length === 0
      ? undefined
      : rounded(
          rate(
            successfulPairs.filter(([left, right]) => left.output.digest === right.output.digest)
              .length,
            successfulPairs.length,
          ),
        )
  return Object.freeze({
    scenarioId: first.scenarioId,
    category: first.category,
    core: first.core,
    direct,
    dsh,
    pairedSamples: pairs.length,
    ...(overhead === undefined ? {} : { latencyOverheadPercent: overhead }),
    successLossPoints: rounded(direct.successRate - dsh.successRate),
    ...(agreement === undefined ? {} : { outputAgreementRate: agreement }),
    comparable:
      direct.attempts > 0 &&
      direct.attempts === dsh.attempts &&
      pairs.length === direct.attempts &&
      observations.every((entry) => entry.model === first.model && entry.effort === first.effort),
  })
}

function invariantWeaknesses(observations: readonly BenchmarkObservation[]): BenchmarkWeakness[] {
  const weaknesses: BenchmarkWeakness[] = []
  const definitions: readonly [keyof BenchmarkInvariants, string, string][] = [
    ['cleanup', 'P0_PROCESS_CLEANUP', 'a benchmark lane leaked or failed to clean a child process'],
    [
      'toolCorrelation',
      'P0_TOOL_CORRELATION',
      'a tool result was missing, duplicated, or mis-correlated',
    ],
    ['policy', 'P0_POLICY_ESCAPE', 'a tool executed outside the benchmark policy'],
    ['transcript', 'P0_TRANSCRIPT_DIVERGENCE', 'the observed transcript silently diverged'],
    ['redaction', 'P0_REDACTION_FAILURE', 'a sanitized artifact exposed protected content'],
  ]
  for (const observation of observations) {
    for (const [field, code, summary] of definitions) {
      if (observation.invariants[field]) continue
      weaknesses.push({
        severity: 'P0',
        code,
        scenarioId: observation.scenarioId,
        summary,
        evidence: `${observation.lane} repetition ${String(observation.repetition)}`,
      })
    }
    if (observation.childProcessesLeaked > 0) {
      weaknesses.push({
        severity: 'P0',
        code: 'P0_CHILD_PROCESS_LEAK',
        scenarioId: observation.scenarioId,
        summary: 'a benchmark lane left test-owned child processes alive',
        evidence: `${observation.lane} leaked ${String(observation.childProcessesLeaked)} child process(es)`,
      })
    }
  }
  return weaknesses
}

function deduplicateWeaknesses(weaknesses: readonly BenchmarkWeakness[]): BenchmarkWeakness[] {
  const seen = new Set<string>()
  return weaknesses.filter((weakness) => {
    const key = `${weakness.code}\u0000${weakness.scenarioId ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function analyzeBenchmark(input: readonly BenchmarkObservation[]): BenchmarkAnalysis {
  const observations = input
    .map(validateBenchmarkObservation)
    .filter((entry) => entry.phase === 'measured')
  const groups = new Map<string, BenchmarkObservation[]>()
  for (const observation of observations) {
    const group = groups.get(observation.scenarioId) ?? []
    group.push(observation)
    groups.set(observation.scenarioId, group)
  }
  const scenarios = [...groups.values()]
    .map(scenarioSummary)
    .sort((left, right) => left.scenarioId.localeCompare(right.scenarioId))
  const weaknesses: BenchmarkWeakness[] = invariantWeaknesses(observations)
  for (const scenario of scenarios) {
    if (!scenario.comparable) {
      weaknesses.push({
        severity: 'P2',
        code: 'P2_INCOMPLETE_PAIRING',
        scenarioId: scenario.scenarioId,
        summary:
          'the scenario does not have one comparable direct and DSH observation per repetition',
        evidence: `direct=${String(scenario.direct.attempts)}, dsh=${String(scenario.dsh.attempts)}, paired=${String(scenario.pairedSamples)}`,
      })
      continue
    }
    if (
      scenario.core &&
      scenario.pairedSamples >= 3 &&
      scenario.direct.successRate >= 80 &&
      scenario.dsh.successRate === 0
    ) {
      weaknesses.push({
        severity: 'P0',
        code: 'P0_CORE_PARITY_FAILURE',
        scenarioId: scenario.scenarioId,
        summary: 'the direct Claude baseline succeeds but the DSH plugin consistently fails',
        evidence: `direct=${String(scenario.direct.successRate)}%, dsh=0%, pairs=${String(scenario.pairedSamples)}`,
      })
    }
    if (
      scenario.pairedSamples >= BENCHMARK_MIN_LATENCY_SAMPLES &&
      (scenario.latencyOverheadPercent ?? 0) > BENCHMARK_P1_LATENCY_OVERHEAD_PERCENT
    ) {
      weaknesses.push({
        severity: 'P1',
        code: 'P1_LATENCY_OVERHEAD',
        scenarioId: scenario.scenarioId,
        summary: 'median DSH latency overhead exceeds the regression threshold',
        evidence: `${String(scenario.latencyOverheadPercent)}% over ${String(scenario.pairedSamples)} paired samples`,
      })
    }
    if (scenario.successLossPoints > BENCHMARK_P1_SUCCESS_LOSS_POINTS) {
      weaknesses.push({
        severity: 'P1',
        code: 'P1_SUCCESS_RATE_LOSS',
        scenarioId: scenario.scenarioId,
        summary: 'DSH success rate trails the direct baseline beyond the regression threshold',
        evidence: `${String(scenario.successLossPoints)} percentage points`,
      })
    }
    if (scenario.pairedSamples < BENCHMARK_MIN_LATENCY_SAMPLES) {
      weaknesses.push({
        severity: 'P2',
        code: 'P2_INSUFFICIENT_LATENCY_SAMPLES',
        scenarioId: scenario.scenarioId,
        summary: 'the scenario has too few paired samples for a latency claim',
        evidence: `${String(scenario.pairedSamples)} of ${String(BENCHMARK_MIN_LATENCY_SAMPLES)} required pairs`,
      })
    }
  }
  const uniqueWeaknesses = deduplicateWeaknesses(weaknesses).sort((left, right) => {
    const severityOrder =
      BENCHMARK_SEVERITIES.indexOf(left.severity) - BENCHMARK_SEVERITIES.indexOf(right.severity)
    return severityOrder === 0 ? left.code.localeCompare(right.code) : severityOrder
  })
  return Object.freeze({
    scenarios: Object.freeze(scenarios),
    weaknesses: Object.freeze(uniqueWeaknesses),
    measuredObservations: observations.length,
    comparableScenarios: scenarios.filter((scenario) => scenario.comparable).length,
    complete:
      scenarios.length > 0 &&
      scenarios.every(
        (scenario) =>
          scenario.comparable && scenario.pairedSamples >= BENCHMARK_MIN_LATENCY_SAMPLES,
      ),
  })
}

function metric(value: Distribution | undefined): string {
  if (value === undefined) return 'n/a'
  return `${String(value.median)} / ${String(value.p95)}`
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function renderBenchmarkMarkdown(
  environment: BenchmarkReportEnvironment,
  analysis: BenchmarkAnalysis,
): string {
  const rows = analysis.scenarios.map((scenario) =>
    [
      scenario.scenarioId,
      `${String(scenario.direct.successes)}/${String(scenario.direct.attempts)}`,
      `${String(scenario.dsh.successes)}/${String(scenario.dsh.attempts)}`,
      metric(scenario.direct.durationMs),
      metric(scenario.dsh.durationMs),
      scenario.latencyOverheadPercent === undefined
        ? 'n/a'
        : `${String(scenario.latencyOverheadPercent)}%`,
      scenario.outputAgreementRate === undefined
        ? 'n/a'
        : `${String(scenario.outputAgreementRate)}%`,
    ]
      .map(markdownCell)
      .join(' | '),
  )
  const weaknesses =
    analysis.weaknesses.length === 0
      ? ['- None detected by the completed measurements.']
      : analysis.weaknesses.map(
          (entry) =>
            `- **${entry.severity} ${entry.code}**${entry.scenarioId === undefined ? '' : ` (${entry.scenarioId})`}: ${entry.summary}. Evidence: ${entry.evidence}.`,
        )
  return `# Direct Claude versus DSH Claude benchmark

Status: ${analysis.complete ? 'complete' : 'incomplete; do not use for release or performance claims'}

## Environment

- Generated: ${environment.generatedAt}
- Plugin: ${environment.commit} on ${environment.branch}; dirty=${String(environment.dirty)}
- Runtime: Node ${environment.node}; ${environment.platform}/${environment.arch}
- DSH ${environment.dsh}; Claude Agent SDK ${environment.sdk}; Claude Code ${environment.claudeCode}
- Route: model=${environment.model}; effort=${environment.effort}
- Sampling: ${String(environment.warmups)} warm-up(s), ${String(environment.repetitions)} measured repetition(s)
- Sanitized raw observations: \`${environment.resultsPath}\`

## Method

Each repetition runs the same synthetic fixture twice: directly through the Claude Agent SDK and through DSH's LLM runtime plus this plugin. The pair uses the same model alias, effort, system prompt, workspace contents, tool schemas, and host Claude executable. Lane order alternates by repetition. Warm-ups are excluded. Output text, prompts, tool arguments, tool results, paths, and provider errors are not written to artifacts; only stable verdicts, counts, timing, usage, and SHA-256 digests are retained.

Anthropic documents that partial-message streaming adds raw stream events alongside complete assistant and result messages, and that the latest result's \`modelUsage\` is the whole-query accounting source in streaming-input mode. DSH's testing policy requires real-provider tests for file writing, multi-turn, tool use, and cancellation, and requires verification of external state rather than trusting the model's own claim.

## Results

Latency cells are median / p95 milliseconds.

Scenario | Direct pass | DSH pass | Direct duration | DSH duration | DSH overhead | Output digest agreement
--- | ---: | ---: | ---: | ---: | ---: | ---:
${rows.length === 0 ? 'No authenticated measurements.' : rows.join('\n')}

## Weaknesses

${weaknesses.join('\n')}

## Thresholds

- P0: any policy escape, tool duplication/mis-correlation, transcript corruption, protected-content leak, child-process leak, or consistent core plugin failure when the paired direct baseline succeeds.
- P1: more than ${String(BENCHMARK_P1_LATENCY_OVERHEAD_PERCENT)}% median latency overhead with at least ${String(BENCHMARK_MIN_LATENCY_SAMPLES)} pairs, or more than ${String(BENCHMARK_P1_SUCCESS_LOSS_POINTS)} percentage points of success-rate loss.
- P2: incomplete pairing, too few samples, missing telemetry, documentation, or rare compatibility weaknesses.

## Primary references

- [Anthropic: stream responses in real time](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Anthropic: track cost and usage](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
- [Anthropic: work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [DeepSeek Harness benchmark entry point](https://github.com/deepseek-ai/deepseek-harness/blob/master/BENCHMARK.md)
- [DeepSeek Harness testing policy](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/testing.md)
`
}
