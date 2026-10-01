import { query } from '@anthropic-ai/claude-agent-sdk'
import { officialStatus,profileEnvironment } from '../lib/auth/official.js'
import { mkdirSync,writeFileSync } from 'node:fs'
if(!process.argv.includes('--live')||!process.argv.includes('--extra-usage-off')){console.log(JSON.stringify({status:'BLOCKED',modelCalls:0}));process.exit(2)}
await officialStatus('claude','default')
// Deliberately no provider import: repairing the provider cannot depend on the provider.
const q=query({prompt:'A TypeScript adapter is broken after send changed from send(text) to send({text}). Current line: export const adapt = (send, text) => send(text). Return only the corrected line. No explanation.',options:{pathToClaudeCodeExecutable:'claude',env:profileEnvironment('default'),model:'sonnet',effort:'low',tools:[],mcpServers:{},strictMcpConfig:true,settingSources:[],hooks:{},skills:[],plugins:[],permissionMode:'dontAsk',persistSession:false,maxTurns:1,systemPrompt:'Return the single requested corrected source line only.',settings:{disableAllHooks:true,fastMode:false,autoMemoryEnabled:false,autoCompactEnabled:false}}})
const timer=setTimeout(()=>q.close(),45000);let text='',success=false
try{for await(const e of q){if(e.type==='assistant')for(const b of e.message.content)if(b.type==='text')text+=b.text;if(e.type==='result')success=e.subtype==='success'}
 const compact=text.replace(/\s|;/g,'');if(!success||compact!=='exportconstadapt=(send,text)=>send({text})')throw new Error('FIXTURE_REPAIR_NOT_VALIDATED')
 const report={status:'PASSED',scope:'one direct official SDK coding response with all tools disabled',providerImported:false,providerRequired:false,modelCalls:1,fixtureCorrectionValidated:true,publisherCredentialsPassed:false};mkdirSync('.artifacts',{recursive:true});writeFileSync('.artifacts/live-independent-repair.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}catch(e){console.log(JSON.stringify({status:'FAILED',reason:e.message}));process.exitCode=1}finally{clearTimeout(timer);q.close()}
