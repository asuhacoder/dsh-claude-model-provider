import { toolProtocolError } from './errors.js'

function normalizedJson(value: unknown, path: string, ancestors = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') {
    throw toolProtocolError(`tool JSON at ${path} contains a non-JSON value`)
  }
  if (ancestors.has(value)) throw toolProtocolError(`tool JSON at ${path} contains a cycle`)
  ancestors.add(value)
  let output: unknown
  if (Array.isArray(value)) {
    output = value.map((entry, index) => normalizedJson(entry, `${path}[${index}]`, ancestors))
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw toolProtocolError(`tool JSON at ${path} must contain only plain objects`)
    }
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value).sort()) {
      record[key] = normalizedJson(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
      )
    }
    output = record
  }
  ancestors.delete(value)
  return output
}

export function canonicalToolJson(value: unknown): string {
  return JSON.stringify(normalizedJson(value, '$'))
}

const DOUBLE_ESCAPED_UNICODE =
  /\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][c-fC-F][0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})/g
const WINDOWS_PATH = /(?:^|[^A-Za-z])[A-Za-z]:[\\/]|(?:^|[\s"'=])\\\\[^\s\\/]+[\\/](?!\\)/

function repairedString(text: string): string {
  if (!text.includes('\\u') || WINDOWS_PATH.test(text)) return text
  return text.replace(
    DOUBLE_ESCAPED_UNICODE,
    (
      match: string,
      high: string | undefined,
      low: string | undefined,
      single: string | undefined,
      offset: number,
    ) => {
      let run = offset
      while (run > 0 && text[run - 1] === '\\') run--
      if ((offset - run) % 2 === 1) return match
      if (high !== undefined && low !== undefined) {
        return String.fromCharCode(parseInt(high, 16), parseInt(low, 16))
      }
      if (single === undefined) return match
      const code = parseInt(single, 16)
      if (code >= 0xd800 && code <= 0xdfff) return match
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return match
      return String.fromCharCode(code)
    },
  )
}

function repairedDoubleEscapedUnicode(value: unknown): unknown {
  if (typeof value === 'string') return repairedString(value)
  if (Array.isArray(value)) return value.map(repairedDoubleEscapedUnicode)
  if (value !== null && typeof value === 'object') {
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, entry] of Object.entries(value)) {
      record[key] = repairedDoubleEscapedUnicode(entry)
    }
    return record
  }
  return value
}

/**
 * Claude Code 2.1.287 rewrites `\uXXXX` text inside a tool input's string values into the
 * character before it completes the assistant message, so the completed input can differ from
 * the arguments the model streamed. This mirrors that rewrite to compare the two; DSH still
 * executes the streamed arguments.
 */
export function matchesEmittedToolArguments(emitted: unknown, observedCanonical: string): boolean {
  return (
    canonicalToolJson(emitted) === observedCanonical ||
    canonicalToolJson(repairedDoubleEscapedUnicode(emitted)) === observedCanonical
  )
}
