import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
const input=JSON.parse(process.env.CANDIDATE_TUPLE||readFileSync('.artifacts/upstream.json','utf8'))
const names=['@deepseek-ai/dsh','@anthropic-ai/claude-agent-sdk','dsh-plugin-subscriptions']
for(const name of names){const p=input.packages?.[name];if(!p||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(p.version)||!/^sha512-[A-Za-z0-9+/=]+$/.test(p.integrity))throw new Error('INVALID_PINNED_TUPLE')}
const pkg=JSON.parse(readFileSync('package.json','utf8')),dsh=input.packages['@deepseek-ai/dsh'].version
for(const group of ['dependencies','devDependencies','peerDependencies'])for(const name of Object.keys(pkg[group]??{})){if(name.startsWith('@deepseek-ai/dsh-'))pkg[group][name]=dsh;if(name==='@anthropic-ai/claude-agent-sdk')pkg[group][name]=input.packages[name].version}
writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');mkdirSync('.artifacts',{recursive:true});writeFileSync('.artifacts/candidate-tuple.json',JSON.stringify(input,null,2)+'\n')
