import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
const parse = (source) => parseDocument(source).toJS()
const root = resolve('.'),
  temp = mkdtempSync(join(tmpdir(), 'dsh-provider-install-'))
const coexist = process.argv.includes('--coexist')
const tuple=process.env.DSH_CANDIDATE_TUPLE?JSON.parse(readFileSync(process.env.DSH_CANDIDATE_TUPLE,'utf8')):undefined
const dshVersion=tuple?.packages?.['@deepseek-ai/dsh']?.version??'0.2.0-rc.2',subscriptionsVersion=tuple?.packages?.['dsh-plugin-subscriptions']?.version??'0.9.7'
const env = {
  PATH: process.env.PATH,
  HOME: join(temp, 'home'),
  USERPROFILE: join(temp, 'home'),
  DSH_HOME: join(temp, 'dsh'),
  DSH_AGENTS_HOME: join(temp, 'agents'),
  CI: '1',
  NO_COLOR: '1',
  TMPDIR: process.env.TMPDIR,
  SystemRoot: process.env.SystemRoot,
  npm_config_cache: join(temp, 'npm-cache'),
}
for (const d of [
  env.HOME,
  env.DSH_HOME,
  env.DSH_AGENTS_HOME,
  join(temp, 'cli'),
  join(temp, 'pack'),
])
  mkdirSync(d, { recursive: true })
function run(cmd, args, cwd = root) {
  console.error(JSON.stringify({ stage: args.slice(0, 5) }))
  return execFileSync(cmd, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
try {
  const p = JSON.parse(
    run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', join(temp, 'pack')]),
  )[0]
  const tarball = process.argv.includes('--tarball') ? resolve(process.argv[process.argv.indexOf('--tarball')+1]) : join(temp, 'pack', p.filename),
    digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  writeFileSync(
    join(temp, 'cli/package.json'),
    JSON.stringify({ name: 'isolated-dsh-install', private: true }),
  )
  run(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@deepseek-ai/dsh@'+dshVersion],
    join(temp, 'cli'),
  )
  const bin = join(temp, 'cli/node_modules/.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  const dsh = (args) => run(bin, args)
  if (dsh(['--version']).trim() !== dshVersion) throw new Error('WRONG_DSH_VERSION')
  dsh(['--profile', 'web', '--dump-config'])
  if (coexist)
    dsh(['plugin', '--profile', 'web', 'add', 'dsh-plugin-subscriptions@'+subscriptionsVersion, '--ignore-scripts'])
  const before = parse(dsh(['--profile', 'web', '--dump-config']))
  dsh(['plugin', '--profile', 'web', 'add', tarball, '--ignore-scripts'])
  const after = parse(dsh(['--profile', 'web', '--dump-config']))
  const inserted = after.filter((x) => !before.some((b) => b.id === x.id))
  if (inserted.length !== 1 || inserted[0].name !== '@asuha/dsh-claude-model-provider')
    throw new Error('BAD_COMPOSITION')
  if (JSON.stringify(after.filter((x) => x.id !== inserted[0].id)) !== JSON.stringify(before))
    throw new Error('EXISTING_CONFIG_CHANGED')
  // Resolve the host and provider from the same installed profile, checking service identity.
  const profile = join(env.DSH_HOME, 'profiles/web')
  const probe = join(profile, 'identity-probe.mjs')
  const anchor = join(temp, 'cli/node_modules/@deepseek-ai/dsh/package.json')
  writeFileSync(
    probe,
    `import {createRequire} from 'node:module';import assert from 'node:assert/strict';const host=createRequire(${JSON.stringify(anchor)});const {Context}=await import(host.resolve('@deepseek-ai/cordis'));const {PluginPackages,loadProfile,createRuntimeResolution}=await import(host.resolve('@deepseek-ai/dsh-app-boot'));const profile=loadProfile('dsh','web',${JSON.stringify(anchor)});const ctx=new Context();const resolver=await ctx.plugin(PluginPackages,{resolution:await createRuntimeResolution({installAnchor:${JSON.stringify(anchor)},profile})});const r=createRequire(import.meta.url);const pluginPath=r.resolve('@asuha/dsh-claude-model-provider');const pr=createRequire(pluginPath);assert.equal(host.resolve('@deepseek-ai/dsh-llm'),pr.resolve('@deepseek-ai/dsh-llm'));const p=await import(pluginPath);const L=(await import(host.resolve('@deepseek-ai/dsh-llm'))).default;const S=(await import(host.resolve('@deepseek-ai/dsh-subprocess-local'))).default;const a=await ctx.plugin(L);const b=await ctx.plugin(S);p.apply(ctx);assert(ctx.llm.listProviders().some(x=>x.id==='claude-sdk-local'));assert.equal((await ctx.llm.listModels('claude-sdk-local')).length,0);await b.dispose();await a.dispose();await resolver.dispose();console.log('PASSED');`,
  )

  const probeResult = run('node', [probe], profile)
  if (!probeResult.includes('PASSED')) throw new Error('REGISTRATION_FAILED')
  dsh([
    'plugin',
    '--profile',
    'web',
    'remove',
    '@asuha/dsh-claude-model-provider',
    '--config.ignore-scripts=true',
    '--config.offline=true',
    '--yes',
  ])
  const removed = parse(dsh(['--profile', 'web', '--dump-config']))
  if (JSON.stringify(before) !== JSON.stringify(removed)) throw new Error('RESTORE_FAILED')
  const report = {
    status: 'PASSED',
    level: 'L1',
    dsh: dshVersion,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    artifact_sha256: digest,
    coexist,
    subscriptionVersion: coexist ? subscriptionsVersion : null,
    checks: [
      'empty-HOME-public-install-command',
      'composition-unchanged',
      'runtime-module-identity',
      'actual-LLM-registration',
      'unverified-accounts-not-advertised',
      'uninstall-restores-baseline',
    ],
    generationVerified: false,
    otherProviderNetworkVerified: false,
  }
  mkdirSync('.artifacts', { recursive: true })
  writeFileSync(
    `.artifacts/${coexist ? 'coexist' : 'install'}.json`,
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(JSON.stringify(report))
} catch (e) {
  console.error(
    JSON.stringify({
      status: 'FAILED',
      code: e.message.slice(0, 350),
      stderr: e.stderr?.toString().slice(-2500),
    }),
  )
  process.exitCode = 1
} finally {
  if (process.argv.includes('--keep')) console.error('Retained isolated fixture: ' + temp)
  else rmSync(temp, { recursive: true, force: true })
}
