import { LlmError } from '@deepseek-ai/dsh-llm'

export const CLAUDE_ERROR_CODES = {
  aborted: 'CLAUDE_ABORTED',
  authenticationFailed: 'CLAUDE_AUTHENTICATION_FAILED',
  coldReplayUnsupported: 'CLAUDE_COLD_REPLAY_UNSUPPORTED',
  executableNotFound: 'CLAUDE_EXECUTABLE_NOT_FOUND',
  invalidConfig: 'CLAUDE_INVALID_CONFIG',
  invalidModel: 'CLAUDE_INVALID_MODEL',
  invalidProvider: 'CLAUDE_INVALID_PROVIDER',
  inFlightRecoveryUnsupported: 'CLAUDE_IN_FLIGHT_RECOVERY_UNSUPPORTED',
  modelNotFound: 'CLAUDE_MODEL_NOT_FOUND',
  protocolError: 'CLAUDE_PROTOCOL_ERROR',
  rateLimited: 'CLAUDE_RATE_LIMITED',
  maxTurns: 'CLAUDE_MAX_TURNS',
  maxBudget: 'CLAUDE_MAX_BUDGET',
  structuredOutputRetries: 'CLAUDE_STRUCTURED_OUTPUT_RETRIES',
  executionFailed: 'CLAUDE_EXECUTION_FAILED',
  invalidRequest: 'CLAUDE_INVALID_REQUEST',
  toolProtocolError: 'CLAUDE_TOOL_PROTOCOL_ERROR',
  toolTimeout: 'CLAUDE_TOOL_TIMEOUT',
  transportError: 'CLAUDE_TRANSPORT_ERROR',
  transportNotImplemented: 'CLAUDE_TRANSPORT_NOT_IMPLEMENTED',
  unsupportedInput: 'CLAUDE_UNSUPPORTED_INPUT',
  usageEpochReset: 'CLAUDE_USAGE_EPOCH_RESET',
} as const

export type ClaudeErrorCode = (typeof CLAUDE_ERROR_CODES)[keyof typeof CLAUDE_ERROR_CODES]

/** A stable DSH-facing failure emitted by this adapter. */
export class ClaudePluginError extends LlmError {
  constructor(code: ClaudeErrorCode, message: string, cause?: unknown) {
    super(`dsh-claude-plugin: ${message}`, code, cause === undefined ? undefined : { cause })
    this.name = 'ClaudePluginError'
  }
}

export function invalidConfig(message: string, cause?: unknown): ClaudePluginError {
  return new ClaudePluginError(CLAUDE_ERROR_CODES.invalidConfig, message, cause)
}

export function claudeError(
  code: ClaudeErrorCode,
  message: string,
  cause?: unknown,
): ClaudePluginError {
  return new ClaudePluginError(code, message, cause)
}

export function abortError(cause?: unknown): ClaudePluginError {
  return claudeError(CLAUDE_ERROR_CODES.aborted, 'Claude generation was aborted', cause)
}

export function unsupportedInput(message: string): ClaudePluginError {
  return claudeError(CLAUDE_ERROR_CODES.unsupportedInput, message)
}

export function coldReplayUnsupported(message: string, cause?: unknown): ClaudePluginError {
  return claudeError(CLAUDE_ERROR_CODES.coldReplayUnsupported, message, cause)
}

export function inFlightRecoveryUnsupported(message: string): ClaudePluginError {
  return claudeError(CLAUDE_ERROR_CODES.inFlightRecoveryUnsupported, message)
}

export function protocolError(message: string, cause?: unknown): ClaudePluginError {
  return claudeError(CLAUDE_ERROR_CODES.protocolError, message, cause)
}

/** Only adapter-owned messages cross the boundary; SDK/OS exception text stays private. */
export function publicFailureMessage(error: unknown, code: string): string {
  if (code === 'QUEUE_DEADLINE')
    return 'Claude account/session queue wait exceeded queueTimeoutMs; retry when capacity is available'
  if (code === 'REQUEST_DEADLINE')
    return 'Claude generation exceeded requestTimeoutMs; completed DSH tool results are retained'
  if (code === 'OUTCOME_UNKNOWN')
    return 'A prior DSH tool has no completion receipt; verify its outcome before continuing'
  if (error instanceof ClaudePluginError) return error.message.slice(0, 1024)
  return code
}

export function transportError(message: string, cause?: unknown): ClaudePluginError {
  return claudeError(CLAUDE_ERROR_CODES.transportError, message, cause)
}

export function toolProtocolError(message: string, cause?: unknown): ClaudePluginError {
  return claudeError(CLAUDE_ERROR_CODES.toolProtocolError, message, cause)
}

export function toolTimeout(message: string, cause?: unknown): ClaudePluginError {
  return claudeError(CLAUDE_ERROR_CODES.toolTimeout, message, cause)
}

export function transportNotImplemented(model: string): ClaudePluginError {
  return new ClaudePluginError(
    CLAUDE_ERROR_CODES.transportNotImplemented,
    `Claude transport is not implemented yet for model ${JSON.stringify(model)}; ` +
      'install a release containing the managed SDK transport milestone',
  )
}
