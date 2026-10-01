import type { Context } from '@deepseek-ai/cordis'
import { AccountController } from './controller.js'
import { RouteBlocked } from '../routing/types.js'
export const actions = [
  'status',
  'add',
  'verify',
  'login',
  'remove',
  'setDefault',
  'setModel',
] as const
export interface ProviderRoute {
  path: string
  methods: readonly ['POST']
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}
export function accountRoute(action: string, controller: AccountController): ProviderRoute {
  const method = 'claude-sdk-local.' + action
  return {
    path: '/api/' + method,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        return new Response(null, { status: 415 })
      let b: Record<string, unknown>
      try {
        const text = await request.text()
        if (text.length > 8192) return new Response(null, { status: 413 })
        b = JSON.parse(text)
        if (!b || typeof b !== 'object') throw new Error()
      } catch {
        return new Response(null, { status: 400 })
      }
      const rpcId = typeof b.rpcId === 'string' ? b.rpcId : 'invalid'
      let result: unknown
      try {
        if (b.type !== 'client-request' || b.method !== method || rpcId === 'invalid')
          throw new RouteBlocked('INVALID_ENVELOPE')
        result = { ok: true, value: await controller.execute(action, b.payload) }
      } catch (error) {
        const code = error instanceof RouteBlocked ? error.code : 'ACCOUNT_OPERATION_FAILED'
        result = { ok: false, error: { code, message: code, details: {} } }
      }
      return Response.json({ type: 'server-response', rpcId, result })
    },
  }
}
/** Uses the host's authenticated /api transport; never registers a raw web route. */
export function registerAccountUi(ctx: Context, controller: AccountController): void {
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection') as {
      fetch: { register: (route: ProviderRoute) => () => Promise<void> }
    }
    for (const action of actions)
      scope.effect(
        () => connection.fetch.register(accountRoute(action, controller)),
        'claude-sdk-local: ' + action,
      )
  })
}
