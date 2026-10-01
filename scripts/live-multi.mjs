import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { resolveConfig } from '../lib/index.js'
import { SubscriptionProvider } from '../lib/sessions/provider.js'
import { verifyAccount,assertAccount } from '../lib/auth/official.js'
import { StickyRouter } from '../lib/routing/router.js'
import { mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const report={level:'L4',modelCalls:0};let p,fiber,root
try{
 const i=process.argv.indexOf('--profiles-json')
 if(!process.argv.includes('--live')||!process.argv.includes('--extra-usage-off')||i<0)throw Object.assign(new Error('two_distinct_official_profiles_and_explicit_live_flags_required'),{blocked:true})
 const profiles=JSON.parse(readFileSync(process.argv[i+1],'utf8'));if(!Array.isArray(profiles)||profiles.length!==2||!profiles.every(x=>typeof x==='string'))throw new Error('INVALID_PROFILE_LIST')
 const ctx=new Context();fiber=await ctx.plugin(LocalSubprocessRuntime);root=mkdtempSync(join(tmpdir(),'dsh-live-multi-'));p=new SubscriptionProvider(ctx.subprocess,resolveConfig({stateDirectory:root,portableColdStart:true,maxGenerations:4}));const router=new StickyRouter(p.store)
 for(let n=0;n<2;n++)router.register(await verifyAccount(p.store,'claude','profile-'+n,profiles[n],true))
 const accounts=p.accounts();if(accounts.length!==2)throw Object.assign(new Error('profiles_resolve_to_same_subscription_identity'),{blocked:true})
 // Both references must still resolve to different identities after both control sessions.
 for(const a of accounts)await assertAccount(p.store,'claude',a)
 const request={provider:'claude-sdk-local',model:'opus',sessionId:'multi',messages:[{role:'user',content:[{type:'text',text:'Reply only MULTI_OK.'}]}]}
 const turn=async()=>{report.modelCalls++;const chunks=[];for await(const c of p.stream({...request,signal:AbortSignal.timeout(45000)},'opus'))chunks.push(c);if(chunks.at(-1)?.reason.kind!=='stop'||!chunks.some(c=>c.type==='block-end'&&c.block.type==='text'&&c.block.text.includes('MULTI_OK')))throw new Error('LIVE_MULTI_RESPONSE_FAILED')}
 await turn();const first=p.store.list('bindings')[0].identity;router.observe(first,{key:'fixture-confirmed-quota',scope:'*',epoch:'fixture',observedAt:Date.now(),hardBlockedUntil:Date.now()+60000,source:'fixture'});await turn();const second=p.store.list('bindings')[0].identity;if(first===second)throw new Error('MIGRATION_NOT_OBSERVED');for(const a of accounts)await assertAccount(p.store,'claude',a)
 Object.assign(report,{status:'PASSED',distinctIdentities:2,migration:'fixture quota across two real accounts',identityRechecked:true,scope:'bounded sequential profile isolation; no exhaustion load test'})
}catch(e){Object.assign(report,{status:e.blocked?'BLOCKED':'FAILED',reason:e.message});process.exitCode=e.blocked?2:1}finally{await p?.dispose();await fiber?.dispose();if(root)rmSync(root,{recursive:true,force:true});mkdirSync('.artifacts',{recursive:true});writeFileSync('.artifacts/live-multi.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))}
