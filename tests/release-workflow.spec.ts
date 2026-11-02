import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowText = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const workflow = parse(workflowText) as {
  on: { push: { tags: string[] }; workflow_dispatch?: unknown }
  jobs: Record<
    string,
    {
      environment?: string
      permissions?: Record<string, string>
      steps?: { run?: string }[]
    }
  >
}
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  .version as string

function job(name: string) {
  const found = workflow.jobs[name]
  if (!found) throw new Error(`missing job ${name}`)
  return found
}

function runs(name: string) {
  return (job(name).steps ?? []).map((step) => step.run ?? '').join('\n')
}

describe('tag release workflow', () => {
  it('publishes a prerelease tag through npm-next and keeps the rehearsed files', () => {
    expect(workflow.on.push.tags).toEqual(['v*'])
    expect(workflow.on.workflow_dispatch).toBeDefined()
    const publish = job('publish-next')
    expect(publish.environment).toBe('npm-next')
    expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' })
    expect(job('github-release').permissions).toEqual({ contents: 'write' })
    expect(workflowText).not.toContain('NPM_TOKEN')
    expect(runs('publish-next')).toContain('npm install --global npm@11.19.1')
    const release = runs('github-release')
    expect(release).toContain('--prerelease')
    expect(release).toContain('--latest=false')
    expect(release).toContain('verified-release/dist/*.tgz')
    expect(release).toContain('verified-release/.artifacts/release-dry-run.json')
    expect(release).toContain('verified-release/.artifacts/sbom.cdx.json')
  })

  it('names the package version in the install docs that ship in the tarball', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const readmeJa = readFileSync(new URL('../README.ja.md', import.meta.url), 'utf8')
    expect(readme).toContain(`This source prepares \`${version}\``)
    expect(readme).toContain(`asuha-dsh-claude-model-provider-${version}.tgz`)
    expect(readmeJa).toContain(`このソースは \`${version}\` の公開準備版です`)
  })
})
