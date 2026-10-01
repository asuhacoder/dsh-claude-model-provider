import {readFileSync,writeFileSync,mkdirSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {parseDocument} from 'yaml'
const source=readFileSync('pnpm-lock.yaml','utf8'),lock=parseDocument(source).toJS(),pkg=JSON.parse(readFileSync('package.json','utf8')),root=lock.importers['.'],components=new Map(),edges=new Map()
const clean=version=>version.split('(')[0]
const purl=(name,version)=>'pkg:npm/'+name.split('/').map(encodeURIComponent).join('/')+'@'+encodeURIComponent(version)
function visit(name,version){
 const base=clean(version),key=name+'@'+version,ref=purl(name,base)
 if(components.has(ref))return ref
 const meta=lock.packages[name+'@'+base],snapshot=lock.snapshots[key]
 if(!meta||!snapshot)throw new Error('SBOM_LOCK_ENTRY_MISSING: '+name)
 const slash=name.lastIndexOf('/'),integrity=meta.resolution?.integrity
 components.set(ref,{type:'library',...(slash<0?{}:{group:name.slice(0,slash)}),name:name.slice(slash+1),version:base,'bom-ref':ref,purl:ref,...(integrity?.startsWith('sha512-')?{hashes:[{alg:'SHA-512',content:Buffer.from(integrity.slice(7),'base64').toString('hex')}]}:{})})
 edges.set(ref,new Set())
 for(const [n,v] of Object.entries({...snapshot.dependencies,...snapshot.optionalDependencies}))edges.get(ref).add(visit(n,v))
 return ref
}
const rootRef=purl(pkg.name,pkg.version),required={...root.dependencies}
for(const name of Object.keys(pkg.peerDependencies??{}))if(!required[name]&&root.devDependencies?.[name])required[name]=root.devDependencies[name]
const rootEdges=Object.entries(required).map(([n,d])=>visit(n,d.version)).sort()
const bom={bomFormat:'CycloneDX',specVersion:'1.6',version:1,metadata:{component:{type:'application',name:pkg.name,version:pkg.version,'bom-ref':rootRef,purl:rootRef},properties:[{name:'dsh:source',value:'pnpm-lock.yaml'},{name:'dsh:lock-sha256',value:createHash('sha256').update(source).digest('hex')},{name:'dsh:scope',value:'production and peer dependency closure, including optional platform variants'}]},components:[...components.values()].sort((a,b)=>a.purl.localeCompare(b.purl)),dependencies:[{ref:rootRef,dependsOn:rootEdges},...[...edges].map(([ref,dependencies])=>({ref,dependsOn:[...dependencies].sort()}))]}
for(const e of bom.dependencies)for(const ref of e.dependsOn)if(!components.has(ref))throw new Error('SBOM_DANGLING_REFERENCE')
mkdirSync('.artifacts',{recursive:true});writeFileSync('.artifacts/sbom.cdx.json',JSON.stringify(bom,null,2)+'\n');console.log(JSON.stringify({status:'PASSED',format:'CycloneDX 1.6',components:components.size}))
