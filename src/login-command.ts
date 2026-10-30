import { parseLoginLabel } from './login-view.js'

export interface ClaudeLoginInvocation {
  readonly rawInput: string
}

export type ClaudeLoginResult =
  | { readonly kind: 'success' }
  | { readonly kind: 'error'; readonly text: 'INVALID_PAYLOAD' }

export function claudeLoginResult(rawInput: string): ClaudeLoginResult {
  return parseLoginLabel(rawInput.trim()) === undefined
    ? { kind: 'error', text: 'INVALID_PAYLOAD' }
    : { kind: 'success' }
}

export interface ClaudeLoginCommands {
  register(definition: {
    readonly name: 'claude-login'
    readonly description: string
    readonly input: { readonly hint: string }
    readonly handler: (invocation: ClaudeLoginInvocation) => ClaudeLoginResult
  }): () => void
}

export function registerClaudeLoginCommand(commands: ClaudeLoginCommands): () => void {
  return commands.register({
    name: 'claude-login',
    description: 'Log a Claude account back in from this chat',
    input: { hint: 'account alias or profile path' },
    handler: (invocation) => claudeLoginResult(invocation.rawInput),
  })
}
