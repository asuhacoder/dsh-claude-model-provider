import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const MAX_LINKS = 3
const MAX_FRAMES = 5
const MAX_FRAME_LENGTH = 120
const IDENTIFIER = /^[\w.:-]{1,64}$/

/** One exception in a cause chain. Messages are never kept; they can quote payload. */
export interface FailureLink {
  name: string
  code?: string
  frames: string[]
}

export interface ProcessExit {
  exitCode: number | null
  signal: string | null
  /** True when the adapter or SDK asked the child to stop before it exited. */
  requested: boolean
}

export interface SdkTrail {
  events: number
  last?: string
  lastAt?: number
}

/** Payload-free record of why one request attempt failed, stored with its usage row. */
export interface FailureEvidence {
  code: string
  phase: string
  chain: FailureLink[]
  cleanup?: FailureLink[]
  sdk: SdkTrail & { silentMs?: number }
  process?: ProcessExit
}

const cleanupFailures = new WeakMap<object, unknown>()

/** Remembers a cleanup failure beside the failure it must not replace. */
export function noteCleanupFailure(first: unknown, cleanup: unknown): void {
  if (typeof first === 'object' && first !== null && !cleanupFailures.has(first))
    cleanupFailures.set(first, cleanup)
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : undefined
}

function shortPath(path: string): string {
  const modules = path.lastIndexOf('/node_modules/')
  if (modules >= 0) return path.slice(modules + '/node_modules/'.length)
  return path.split(/[\\/]/).slice(-3).join('/')
}

/** Keeps the function name and a location without the host directory prefix. */
function frame(line: string): string {
  return line
    .trim()
    .replace(/^at /, '')
    .replace(/[^\s()]*[\\/][^\s()]*/g, shortPath)
    .slice(0, MAX_FRAME_LENGTH)
}

function link(error: unknown): FailureLink {
  if (!(error instanceof Error)) return { name: typeof error, frames: [] }
  const code = 'code' in error ? identifier(error.code) : undefined
  return {
    name: identifier(error.name) ?? 'Error',
    ...(code === undefined ? {} : { code }),
    frames: (error.stack ?? '')
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .slice(0, MAX_FRAMES)
      .map(frame),
  }
}

/** The exception and its causes as names, codes, and stack locations. */
export function describeError(error: unknown): FailureLink[] {
  const chain: FailureLink[] = []
  for (let current = error; current !== undefined && chain.length < MAX_LINKS;) {
    chain.push(link(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return chain
}

export function describeCleanupFailure(first: unknown): FailureLink[] | undefined {
  if (typeof first !== 'object' || first === null || !cleanupFailures.has(first)) return undefined
  return describeError(cleanupFailures.get(first))
}

/** Protocol discriminators only, for example `stream_event:content_block_delta:input_json_delta`. */
export function sdkEventKind(event: SDKMessage): string {
  const parts: unknown[] = [event.type]
  if ('subtype' in event) parts.push(event.subtype)
  if (event.type === 'stream_event') {
    parts.push(event.event.type)
    if (event.event.type === 'content_block_delta') parts.push(event.event.delta.type)
    if (event.event.type === 'content_block_start') parts.push(event.event.content_block.type)
  }
  return parts.map((part) => identifier(part) ?? 'unrecognized').join(':')
}

/** One line for the DSH failure message: exception name, first frame, and the evidence id. */
export function summarizeUnclassified(error: unknown, evidenceId: string | undefined): string {
  const [first] = describeError(error)
  const where = first?.frames[0] === undefined ? '' : ` at ${first.frames[0]}`
  const stored = evidenceId === undefined ? '' : `; evidence stored in usage record ${evidenceId}`
  return `unclassified ${first?.name ?? 'failure'}${where}${stored}`
}
