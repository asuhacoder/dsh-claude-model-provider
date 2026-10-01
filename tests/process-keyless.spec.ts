import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ClaudeProcessFactory } from '../src/process.js'
import { resolveConfig } from '../src/index.js'

describe('real keyless subprocess fixture', () => {
  it('round-trips bytes and exits cleanly through DSH local subprocess and the SDK facade', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const factory = new ClaudeProcessFactory(ctx.subprocess, resolveConfig())
    const controller = new AbortController()
    const spawned = factory.spawn({
      command: process.execPath,
      args: [
        '-e',
        "process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('fixture-ok')})",
      ],
      cwd: process.cwd(),
      env: {
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        DSH_SHOULD_NOT_LEAK: 'blocked',
      },
      signal: controller.signal,
    })
    let stdout = ''
    spawned.stdout.setEncoding('utf8')
    spawned.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    spawned.stdin.end('hello fixture')
    await new Promise<void>((resolve) => {
      spawned.once('exit', () => resolve())
    })
    expect(stdout).toBe('HELLO FIXTURE')
    expect(spawned.exitCode).toBe(0)
    expect(spawned.killed).toBe(false)
    await factory.dispose()
    await fiber.dispose()
  })
})
