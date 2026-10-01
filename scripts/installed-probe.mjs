import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
const [anchor,profileDirectory]=process.argv.slice(2)
const host=createRequire(anchor)
const {Context}=await import(host.resolve('@deepseek-ai/cordis'))
const {PluginPackages,loadProfile,createRuntimeResolution}=await import(host.resolve('@deepseek-ai/dsh-app-boot'))
const profile=loadProfile('dsh','web',anchor)
const ctx=new Context()
const resolver=await ctx.plugin(PluginPackages,{resolution:await createRuntimeResolution({installAnchor:anchor,profile})})
const r=createRequire(profileDirectory+'/probe.mjs'),pluginPath=r.resolve('@asuhacoder/dsh-session-provider'),pr=createRequire(pluginPath)
assert.equal(host.resolve('@deepseek-ai/dsh-llm'),pr.resolve('@deepseek-ai/dsh-llm'))
const p=await import(pathToFileURL(pluginPath).href)
const L=(await import(host.resolve('@deepseek-ai/dsh-llm'))).default
const S=(await import(host.resolve('@deepseek-ai/dsh-subprocess-local'))).default
const a=await ctx.plugin(L),b=await ctx.plugin(S)
const config=p.resolveConfig(),bridge=new p.BridgeManager(ctx.subprocess,config)
ctx.llm.registerAdapter(['claude-sdk-local'],new p.ClaudeCodeAdapter(config,bridge))
assert(ctx.llm.listProviders().some(x=>x.id==='claude-sdk-local'))
assert((await ctx.llm.listModels('claude-sdk-local')).length>0)
await bridge.dispose();await b.dispose();await a.dispose();await resolver.dispose()
console.log(JSON.stringify({status:'PASSED',moduleIdentity:true,registration:true}))
