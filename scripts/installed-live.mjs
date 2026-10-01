import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {dirname,join,resolve} from 'node:path'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
if(!process.argv.includes('--live')||!process.argv.includes('--extra-usage-off')){console.log(JSON.stringify({status:'BLOCKED',modelCalls:0}));process.exit(2)}
const [anchor,profileName,profileDirectory,stateDirectory,tarball]=process.argv.slice(2,7),host=createRequire(anchor)
const {Context}=await import(host.resolve('@deepseek-ai/cordis')),{PluginPackages,loadProfile,createRuntimeResolution}=await import(host.resolve('@deepseek-ai/dsh-app-boot'))
const ctx=new Context(),fibers=[];let provider
try{
 const profile=loadProfile('dsh',profileName,anchor)
 fibers.push(await ctx.plugin(PluginPackages,{resolution:await createRuntimeResolution({installAnchor:anchor,profile})}))
 const entry=createRequire(profileDirectory+'/probe.mjs').resolve('@asuha/dsh-claude-model-provider'),p=await import(pathToFileURL(entry).href),{SubscriptionProvider}=await import(pathToFileURL(join(dirname(entry),'sessions/provider.js')).href)
 if(host.resolve('@deepseek-ai/dsh-llm')!==createRequire(entry).resolve('@deepseek-ai/dsh-llm'))throw new Error('CORE_IDENTITY_MISMATCH')
 fibers.push(await ctx.plugin((await import(host.resolve('@deepseek-ai/dsh-llm'))).default),await ctx.plugin((await import(host.resolve('@deepseek-ai/dsh-subprocess-local'))).default))
 const config=p.resolveConfig({stateDirectory,maxGenerations:1,requestTimeoutMs:45000});provider=new SubscriptionProvider(ctx.subprocess,config);ctx.llm.registerAdapter(['claude-sdk-local'],new p.ClaudeCodeAdapter(config,provider))
 const chunks=[];for await(const c of ctx.llm.stream({provider:'claude-sdk-local',model:'opus',reasoningEffort:'low',sessionId:'installed-next2-smoke',messages:[{role:'user',content:[{type:'text',text:'Reply only INSTALLED_OK.'}]}],signal:AbortSignal.timeout(45000)}))chunks.push(c)
 if(chunks.at(-1)?.reason.kind!=='stop'||!chunks.some(c=>c.type==='block-end'&&c.block.type==='text'&&c.block.text.includes('INSTALLED_OK')))throw new Error('INSTALLED_RESPONSE_FAILED')
 const report={status:'PASSED',level:'L2',scope:'one real request through installed tarball and host module resolver',modelCalls:1,moduleIdentity:true,artifactSha256:createHash('sha256').update(readFileSync(tarball)).digest('hex'),usage:chunks.filter(c=>c.type==='usage').map(c=>c.usage)};mkdirSync('.artifacts',{recursive:true});writeFileSync('.artifacts/installed-next2-live.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}catch(e){console.log(JSON.stringify({status:'FAILED',code:e.message}));process.exitCode=1}finally{await provider?.dispose();for(const f of fibers.reverse())await f.dispose()}
