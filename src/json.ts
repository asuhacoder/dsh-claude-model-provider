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
