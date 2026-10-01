import {
  ReasoningEffortId,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import { CLAUDE_ERROR_CODES, ClaudePluginError } from './errors.js'

export const PROVIDER_ID = 'claude-sdk-local'
export const PROVIDER_NAME = 'Claude (official SDK)'
export const BUILTIN_MODEL_ALIASES = ['default', 'sonnet', 'opus', 'haiku'] as const
export const CLAUDE_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type ClaudeReasoningEffort = (typeof CLAUDE_REASONING_EFFORTS)[number]

export function resolveClaudeEffort(value: unknown): EffortLevel | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ClaudePluginError(
      CLAUDE_ERROR_CODES.invalidModel,
      'Claude reasoning effort must be a string',
    )
  }
  const effort = value
  if (!(CLAUDE_REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new ClaudePluginError(
      CLAUDE_ERROR_CODES.invalidModel,
      `Claude reasoning effort must be one of ${CLAUDE_REASONING_EFFORTS.join(', ')}`,
    )
  }
  return effort as ClaudeReasoningEffort
}

function reasoningInfo(): NonNullable<LlmResolvedModelInfo['reasoning']> {
  return Object.freeze({
    efforts: Object.freeze(
      CLAUDE_REASONING_EFFORTS.map((id) =>
        Object.freeze({
          id: ReasoningEffortId(id),
          name: id[0]!.toUpperCase() + id.slice(1),
          description: `${id} Claude adaptive-thinking effort`,
        }),
      ),
    ),
  })
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}

export function validateModelId(value: unknown, label = 'model'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ClaudePluginError(
      CLAUDE_ERROR_CODES.invalidModel,
      `${label} must be a non-empty string`,
    )
  }
  if (value !== value.trim()) {
    throw new ClaudePluginError(
      CLAUDE_ERROR_CODES.invalidModel,
      `${label} must not contain surrounding whitespace`,
    )
  }
  if (value.length > 256 || hasControlCharacter(value)) {
    throw new ClaudePluginError(
      CLAUDE_ERROR_CODES.invalidModel,
      `${label} must be at most 256 characters and contain no control characters`,
    )
  }
  return value
}

export function resolveClaudeModel(requested: unknown, defaultModel: string): string {
  const model = validateModelId(requested)
  if (model !== 'default') return model
  const resolvedDefault = validateModelId(defaultModel, 'defaultModel')
  if (resolvedDefault === 'default') {
    throw new ClaudePluginError(
      CLAUDE_ERROR_CODES.invalidModel,
      'defaultModel must resolve the default alias to a concrete Claude model',
    )
  }
  return resolvedDefault
}

function displayName(model: string): string {
  switch (model) {
    case 'sonnet':
      return 'Claude Sonnet'
    case 'opus':
      return 'Claude Opus'
    case 'haiku':
      return 'Claude Haiku'
    default:
      return model
  }
}

export function modelCatalog(defaultModel: string): readonly LlmModelInfo[] {
  const resolvedDefault = resolveClaudeModel('default', defaultModel)
  const entries: LlmModelInfo[] = BUILTIN_MODEL_ALIASES.map((id) => ({
    provider: PROVIDER_ID,
    id,
    name: id === 'default' ? `${displayName(resolvedDefault)} (default)` : displayName(id),
    description:
      id === 'default'
        ? `Resolves to the configured Claude model ${resolvedDefault}`
        : `Claude Code ${id} alias`,
    inputModalities: ['text', 'image'],
  }))
  return Object.freeze(entries.map((entry) => Object.freeze(entry)))
}

export function resolvedModelInfo(
  provider: string,
  requested: unknown,
  defaultModel: string,
): LlmResolvedModelInfo {
  if (provider !== PROVIDER_ID) {
    throw new ClaudePluginError(
      CLAUDE_ERROR_CODES.invalidProvider,
      `expected provider ${JSON.stringify(PROVIDER_ID)}, received ${JSON.stringify(provider)}`,
    )
  }
  const id = validateModelId(requested)
  const claudeModel = resolveClaudeModel(id, defaultModel)
  return {
    provider,
    id,
    name: id === 'default' ? `${displayName(claudeModel)} (default)` : displayName(id),
    description:
      id === claudeModel
        ? `Claude Code model ${claudeModel}`
        : `Claude Code alias resolving to ${claudeModel}`,
    inputModalities: ['text', 'image'],
    reasoning: reasoningInfo(),
  }
}

/** Runtime catalog from official control responses, with each account's effort capabilities. */
export function accountModelCatalog(
  accounts: readonly import('./routing/types.js').Account[],
  defaultModel: string,
): readonly LlmModelInfo[] {
  const ids = [
    ...new Set(
      accounts
        .filter((a) => a.state !== 'DISABLED' && a.state !== 'SUSPENDED')
        .flatMap((a) => Object.keys(a.models)),
    ),
  ].sort()
  return [...(ids.includes(defaultModel) ? ['default'] : []), ...ids].map((id) => ({
    provider: PROVIDER_ID,
    id,
    name: id === 'default' ? `${displayName(defaultModel)} (default)` : displayName(id),
    inputModalities: ['text', 'image'] as const,
  }))
}
export function accountModelInfo(
  accounts: readonly import('./routing/types.js').Account[],
  provider: string,
  model: string,
  defaultModel: string,
): LlmResolvedModelInfo {
  const result = resolvedModelInfo(provider, model, defaultModel),
    id = resolveClaudeModel(model, defaultModel)
  const matching = accounts.filter(
    (a) => a.state !== 'DISABLED' && a.state !== 'SUSPENDED' && a.models[id] !== undefined,
  )
  if (!matching.length)
    throw new ClaudePluginError(
      CLAUDE_ERROR_CODES.invalidModel,
      'Model has not been verified for an active account',
    )
  const efforts = [...new Set(matching.flatMap((a) => a.models[id]!))].filter((e) =>
    (CLAUDE_REASONING_EFFORTS as readonly string[]).includes(e),
  )
  // DSH rejects an empty effort list and drops the entire provider catalog.
  // An absent capability is represented by omitting reasoning metadata.
  const { reasoning: _fallbackReasoning, ...metadata } = result
  return {
    ...metadata,
    ...(efforts.length
      ? { reasoning: { efforts: efforts.map((e) => ({ id: ReasoningEffortId(e), name: e })) } }
      : {}),
  }
}
