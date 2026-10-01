import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
const packageName = JSON.parse(readFileSync('package.json', 'utf8')).name
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
