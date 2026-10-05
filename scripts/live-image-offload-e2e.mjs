import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { png } from './png-fixture.mjs'

if (!process.argv.includes('--live') || !process.argv.includes('--extra-usage-off')) {
  console.log(
    JSON.stringify({ status: 'BLOCKED', reason: 'explicit_live_and_extra_usage_off_required' }),
  )
  process.exit(2)
}
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')
const fixture = mkdtempSync(join(tmpdir(), 'dsh-claude-offload-e2e-'))
const home = join(fixture, 'dsh-home')
const work = join(fixture, 'work')
const pack = join(fixture, 'pack')
const profile = join(home, 'profiles', 'headless')
const env = {
  ...process.env,
  CI: '1',
  NO_COLOR: '1',
  DSH_HOME: home,
  DSH_AGENTS_HOME: join(fixture, 'agents-home'),
  npm_config_cache: join(fixture, 'npm-cache'),
}
const run = (command, args, cwd = repository) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1_024 * 1_024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
const events = (raw) =>
  raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

// Each fixture is about 99 kB, so one fits the 150 kB replay budget and two do not.
const IMAGE_BYTE_BUDGET = 150_000
const PATCH = `- id: session-telemetry-otel
  config:
    mode: DISABLED
- id: session-log-deepseek
  config:
    enabled: false
- id: agent-default-model
  config:
    provider: claude-sdk-local
    model: opus
- id: attachment-local
  config:
    maxMessageImageBytes: ${IMAGE_BYTE_BUDGET}
- id: llm-claude-sdk-local
  config:
    portableColdStart: true
`

try {
  mkdirSync(work, { recursive: true })
  mkdirSync(pack, { recursive: true })
  writeFileSync(join(work, 'first.png'), png(256, [255, 0, 0], 128))
  writeFileSync(join(work, 'second.png'), png(256, [0, 0, 255], 128))
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', pack])
  const tarball = join(pack, readdirSync(pack)[0])
  run('dsh', ['plugin', '--profile', 'headless', 'add', tarball, '--ignore-scripts'])
  writeFileSync(join(profile, 'cordis.patch.yml'), PATCH)
  run('dsh', [
    'plugin',
    '--profile',
    'headless',
    'exec',
    'dsh-claude-model-provider',
    'accounts',
    'add',
    'main',
    '--extra-usage-off',
  ])

  const first = events(
    run(
      'dsh',
      [
        '--profile',
        'headless',
        '--json',
        'Call read_image on first.png. After you get its result, call read_image on second.png in a separate later step, never both in one step. Then reply exactly: first=<colour of the solid top half of first.png> second=<colour of the solid top half of second.png>',
      ],
      work,
    ),
  )
  const sessionId = first.find((event) => event.type === 'session').sessionId
  // A new process resumes cold, so the provider replays both images in one frame.
  const second = events(
    run(
      'dsh',
      [
        '--profile',
        'headless',
        '--json',
        '--session-id',
        sessionId,
        'Text-only follow-up. If an earlier image now appears as a bracketed placeholder, quote that placeholder verbatim on one line. Then state how many real images you can currently see.',
      ],
      work,
    ),
  )
  const answer = second.find((event) => event.type === 'final')?.text ?? ''

  const sessionRoot = join(home, 'sessions')
  const sessionFile = join(
    sessionRoot,
    readdirSync(sessionRoot)[0],
    sessionId,
    'session.v4.jsonl.zstd',
  )
  const compressed = readFileSync(sessionFile)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const frames = []
  for (let at = compressed.indexOf(magic); at !== -1; at = compressed.indexOf(magic, at + 4))
    frames.push(at)
  const log = frames
    .map((at, index) => zstdDecompressSync(compressed.subarray(at, frames[index + 1])).toString())
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const rejection = log.findIndex(
    (event) =>
      event.type === 'assistant/attempt' &&
      JSON.stringify(event).includes('IMAGE_OFFLOAD_REQUIRED'),
  )
  const offload = log.findIndex((event) => event.type === 'image/offload')
  const placeholderPath = /Normalized copy \(read-only[^"]*"([^"]+)"/.exec(answer)?.[1]

  const checks = {
    firstTurnSawBothImages: /first=red\s+second=blue/i.test(
      first.find((event) => event.type === 'final')?.text ?? '',
    ),
    providerRequestedOffload: rejection !== -1,
    harnessRecordedOffloadAfterRejection: offload > rejection && rejection !== -1,
    followUpCompleted: second.some(
      (event) => event.phase === 'turn_end' && event.reason?.kind === 'completed',
    ),
    placeholderNamesReadOnlyPath:
      placeholderPath !== undefined &&
      readFileSync(placeholderPath).subarray(1, 4).toString() === 'PNG',
  }
  const report = {
    status: Object.values(checks).every(Boolean) ? 'PASSED' : 'FAILED',
    scope:
      'real dsh headless profile + packed tarball + official SDK; cold resume over a lowered image byte budget',
    modelTurns: 2,
    checks,
    offloadTargets: log[offload]?.data.targets,
  }
  mkdirSync(join(repository, '.artifacts'), { recursive: true })
  writeFileSync(
    join(repository, '.artifacts/live-image-offload-e2e.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'PASSED') process.exitCode = 1
} finally {
  if (keep) process.stderr.write(`fixture retained at ${fixture}\n`)
  else rmSync(fixture, { recursive: true, force: true })
}
