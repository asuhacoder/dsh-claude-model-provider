import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { createUserMessage,createAssistantMessage,createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SubscriptionProvider } from '../lib/sessions/provider.js'
import { BridgeManager,defaultQueryFactory,resolveConfig } from '../lib/index.js'
import { verifyAccount,assertAccount } from '../lib/auth/official.js'
import { StickyRouter } from '../lib/routing/router.js'
import { mkdtempSync,writeFileSync,mkdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
if(!process.argv.includes('--live')||!process.argv.includes('--extra-usage-off')){console.log(JSON.stringify({status:'BLOCKED',level:'L3',reason:'explicit_live_confirmation_required'}));process.exit(2)}
const ctx=new Context(),root=mkdtempSync(join(tmpdir(),'dsh-hybrid-'));let p,fiber,fakeCalls=0,receiptSeen=false
try{
 fiber=await ctx.plugin(LocalSubprocessRuntime);const config=resolveConfig({stateDirectory:root,portableColdStart:true,maxGenerations:2})
 p=new SubscriptionProvider(ctx.subprocess,config,undefined,{authenticate:(s,c,a)=>a.identity==='fixture-B'?Promise.resolve():assertAccount(s,c,a),createManager:(a,c,observe)=>{
  if(a.identity==='fixture-B')return {dispose:async()=>{},async *stream(options){fakeCalls++;receiptSeen=options.messages.some(m=>m.role==='tool'&&m.content.some(b=>b.type==='text'&&b.text==='RECEIPT_OK'));yield {type:'finish',reason:{kind:'stop'}}}}
  const factory=request=>{const q=defaultQueryFactory(request);return {setModel:m=>q.setModel(m),applyFlagSettings:s=>q.applyFlagSettings(s),interrupt:()=>q.interrupt(),close:()=>q.close(),async *[Symbol.asyncIterator](){for await(const e of q){observe(e);yield e}}}}
  return new BridgeManager(ctx.subprocess,c,factory)
 }})
 const router=new StickyRouter(p.store),real=await verifyAccount(p.store,'claude','primary','default',true);router.register(real)
 const messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Call dsh_receipt exactly once with no arguments.'}]})],options={provider:'claude-sdk-local',model:'opus',reasoningEffort:'low',sessionId:'hybrid',messages,tools:[{name:'dsh_receipt',description:'DSH no-op receipt check.',parameters:{type:'object',properties:{},additionalProperties:false}}],signal:AbortSignal.timeout(45000)}
 const chunks=[];for await(const c of p.stream(options,'opus'))chunks.push(c)
 const blocks=chunks.filter(c=>c.type==='block-end').map(c=>c.block),tool=blocks.find(b=>b.type==='tool-call');if(!tool||tool.name!=='dsh_receipt')throw new Error('REAL_TOOL_NOT_OBSERVED')
 messages.push(createAssistantMessage({source:{provider:'claude-sdk-local',model:'opus'},content:blocks}),createToolResultMessage({callId:tool.id,content:[{type:'text',text:'RECEIPT_OK'}],isError:false}))
 router.register({...real,identity:'fixture-B',aliases:['fixture'],profileRef:'fixture',windows:[]})
 router.observe(real.identity,{key:'fixture-block',scope:'*',epoch:'fixture',observedAt:Date.now(),hardBlockedUntil:Date.now()+60000,source:'fixture'})
 for await(const _ of p.stream({...options,signal:AbortSignal.timeout(5000)},'opus')){}
 if(!receiptSeen||p.store.list('bindings')[0].identity!=='fixture-B')throw new Error('HYBRID_CONTINUATION_FAILED')
 const a=p.store.get('accounts',real.identity);a.windows=[];p.store.set('accounts',real.identity,a)
 for await(const _ of p.stream({...options,signal:AbortSignal.timeout(5000)},'opus')){}
 if(p.store.list('bindings')[0].identity!=='fixture-B'||fakeCalls!==2)throw new Error('AUTOMATIC_FAILBACK')
 const report={status:'PASSED',level:'L3',realAccounts:1,fakeAccounts:1,realModelSteps:1,confirmedFixtureQuota:true,committedReceiptContinued:true,duplicateSideEffects:0,noAutomaticFailback:true,notL4:true};mkdirSync('.artifacts',{recursive:true});writeFileSync('.artifacts/live-hybrid.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}catch(e){console.log(JSON.stringify({status:'FAILED',code:e.message}));process.exitCode=1}finally{await p?.dispose();await fiber?.dispose();rmSync(root,{recursive:true,force:true})}
