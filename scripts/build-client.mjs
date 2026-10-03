import { build } from 'esbuild'
import { readFileSync, chmodSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const packageName = manifest.name
const peerVersions = Object.fromEntries(
  Object.keys(manifest.peerDependencies).map((name) => [
    name,
    require(name + '/package.json').version,
  ]),
)
// `dsh plugin exec` has no host ESM peer resolver. The standalone management
// binary bundles its JS peers; the actual provider keeps host-owned peers external.
await build({
  entryPoints: ['src/provider-cli.ts'],
  outfile: 'lib/provider-cli.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@anthropic-ai/claude-agent-sdk', '@modelcontextprotocol/sdk/*', 'yaml'],
  define: { __DSH_CLI_PEER_VERSIONS__: JSON.stringify(peerVersions) },
  sourcemap: true,
})
chmodSync('lib/provider-cli.js', 0o755)
await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  external: ['react'],
  banner: {
    js:
      'window.__ModuleLoader__.load({id:' +
      JSON.stringify(packageName) +
      ',factory:(require)=>{var module={exports:{}};var exports=module.exports;',
  },
  footer: { js: 'return module.exports;}});' },
  sourcemap: true,
})
