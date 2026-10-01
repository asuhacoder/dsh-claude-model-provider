import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('installable DSH bundle', () => {
  it('publishes the expected entry points and bundle declaration', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest).toMatchObject({
      name: '@asuhacoder/dsh-session-provider',
      type: 'module',
      main: './lib/index.js',
      types: './lib/index.d.ts',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    expect(manifest.files).toEqual([
      'lib/',
      'cordis.patch.yml',
      'AUTHORS.md',
      'README.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md','README.ja.md','COMPLIANCE.md','CAPABILITY_REPORT.json','compatibility.lock.json',
    ])
  })

  it('adds only the adapter row and the default-model patch', async () => {
    const source = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(parse(source)).toEqual([
      {
        insert: [{ id: 'llm-claude-sdk-local', name: '@asuhacoder/dsh-session-provider' }],
      },
    ])
    expect(source).not.toMatch(/security|sandbox|agent-default-model/i)
    expect(root).toMatch(/dsh-session-provider[/\\]$/)
  })
})
