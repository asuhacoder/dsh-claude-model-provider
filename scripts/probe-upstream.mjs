import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
const names=['@deepseek-ai/dsh','@anthropic-ai/claude-agent-sdk','dsh-plugin-subscriptions']
const packages={}
for(const name of names){const res=await fetch('https://registry.npmjs.org/'+encodeURIComponent(name));if(!res.ok)throw new Error('REGISTRY_UNAVAILABLE');const p=await res.json();const version=p['dist-tags'].latest;packages[name]={version,distTags:p['dist-tags'],integrity:p.versions[version].dist.integrity}}
const repo=await (await fetch('https://api.github.com/repos/deepseek-ai/deepseek-harness',{headers:{'User-Agent':'dsh-session-provider-compat'}})).json()
const ref=await (await fetch(`https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/${encodeURIComponent(repo.default_branch)}`,{headers:{'User-Agent':'dsh-session-provider-compat'}})).json()
if(!/^[0-9a-f]{40}$/.test(ref.sha??''))throw new Error('UPSTREAM_SHA_UNAVAILABLE')
const result={schema:1,observedAt:new Date().toISOString(),packages,defaultBranch:repo.default_branch,defaultBranchSha:ref.sha}
let old;try{old=JSON.parse(readFileSync('compatibility.lock.json','utf8'))}catch{}
result.changed=names.some(n=>old?.packages?.[n]?.version!==packages[n].version)||old?.defaultBranchSha!==ref.sha
result.fingerprint=createHash('sha256').update(JSON.stringify([packages,ref.sha])).digest('hex')
mkdirSync('.artifacts',{recursive:true});writeFileSync('.artifacts/upstream.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result))
