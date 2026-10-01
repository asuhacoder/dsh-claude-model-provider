import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { BridgeManager, ClaudeCodeAdapter, resolveConfig } from '../lib/index.js'
import { SubscriptionProvider } from '../lib/sessions/provider.js'
import { resolve } from 'node:path'
import { officialStatus } from '../lib/auth/official.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
if(!process.argv.includes('--live') || !process.argv.includes('--extra-usage-off')) {console.log(JSON.stringify({status:'BLOCKED',reason:'explicit_live_and_extra_usage_off_required'}));process.exit(2)}
await officialStatus('claude','default')
const ctx=new Context(), fibers=[]
const config=resolveConfig({defaultModel:'opus',maxGenerations:6,portableColdStart:true,stateDirectory:resolve('../private-validation-state')})
const checks=[],usage=[];let manager;let calls=0
const sessionId=randomUUID()
const system='DSH is the harness. Only request the tools provided by DSH. Follow the user exactly. Keep all responses extremely short.'
const tools=[{name:'dsh_ping',description:'Return the provided nonce unchanged. DSH executes this no-op.',parameters:{type:'object',properties:{nonce:{type:'string'}},required:['nonce'],additionalProperties:false}}]
let messages=[]
async function turn(prompt,expectText,extra={}) {
 messages.push(createUserMessage({source:{kind:'user'},content:[{type:'text',text:prompt}]}))
 let answer='';let toolCalls=0
 for(let step=0;step<3;step++){
  calls++;const chunks=[]
  for await(const c of ctx.llm.stream({provider:'claude-sdk-local',model:'opus',reasoningEffort:'low',system,sessionId,messages,tools,signal:AbortSignal.timeout(45000),...extra}))chunks.push(c)
  const finish=chunks.findLast(c=>c.type==='finish')
  usage.push(...chunks.filter(c=>c.type==='usage').map(c=>c.usage))
  const blocks=chunks.filter(c=>c.type==='block-end').map(c=>c.block)
  answer+=blocks.filter(c=>c.type==='text').map(c=>c.text).join('')
  if(!['stop','tool-calls'].includes(finish?.reason.kind))throw new Error(finish?.reason.failure?.code??'NO_TERMINAL')
  messages.push(createAssistantMessage({source:{provider:'claude-sdk-local',model:'opus',replayState:finish.replayState},content:blocks}))
  if(finish.reason.kind==='stop')break
  for(const block of blocks.filter(c=>c.type==='tool-call')){
    if(block.name!=='dsh_ping')throw new Error('UNEXPECTED_TOOL')
    const input=JSON.parse(block.arguments);toolCalls++
    messages.push(createToolResultMessage({callId:block.id,content:[{type:'text',text:input.nonce}],isError:false}))
  }
 }
 checks.push({name:expectText,pass:answer.includes(expectText),toolCalls})
 if(!answer.includes(expectText))throw new Error('REPLY_MISMATCH')
}
try {
 fibers.push(await ctx.plugin(LlmRuntime));fibers.push(await ctx.plugin(LocalSubprocessRuntime))
 manager=process.argv.includes('--pooled')?new SubscriptionProvider(ctx.subprocess,config):new BridgeManager(ctx.subprocess,config)
 ctx.llm.registerAdapter(['claude-sdk-local'],new ClaudeCodeAdapter(config,manager))
 await turn('Reply exactly DSH_OK.','DSH_OK')
 await turn('Call dsh_ping with nonce "PING_OK" exactly once, then output only its result.','PING_OK')
 if(checks[1].toolCalls!==1)throw new Error('TOOL_NOT_CALLED_EXACTLY_ONCE')
 const report={status:'PASSED',level:'L2',pooled:process.argv.includes('--pooled'),scope:'real DSH LlmRuntime + managed subprocess + official SDK, text/warm/tool roundtrip',dsh:'0.2.0-rc.2',sdk:'0.3.286',cli:'2.1.283',checks,modelSteps:calls,warmQueries:manager.activeBridgeCount,usage}
 mkdirSync('.artifacts',{recursive:true});writeFileSync(process.argv.includes('--pooled')?'.artifacts/live-pooled.json':'.artifacts/live-smoke.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}catch(e){console.log(JSON.stringify({status:'FAILED',code:e.message,checks,modelSteps:calls}));process.exitCode=1}
finally{await manager?.dispose();for(const f of fibers.reverse())await f.dispose()}
