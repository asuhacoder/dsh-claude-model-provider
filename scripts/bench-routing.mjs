import {performance} from 'node:perf_hooks'
import {choose} from '../lib/routing/router.js'
import {writeFileSync,mkdirSync} from 'node:fs'
const accounts=Array.from({length:32},(_,i)=>({identity:String(i),aliases:[],profileRef:'fixture',state:'READY',models:{opus:['low']},windows:[],parallelLimit:100,verifiedAt:0}))
const times=[];for(let i=0;i<1000;i++){const start=performance.now();choose(accounts,{session:String(i),requestId:String(i),model:'opus',now:0},[]);times.push(performance.now()-start)}times.sort((a,b)=>a-b)
const report={status:times[949]<50?'PASSED':'FAILED',p95Ms:times[949],accounts:32,samples:1000,mode:'baseline',predictorMode:'not-implemented',holdoutImprovement:'NOT_RUN',liveEfficiencyClaim:false}
mkdirSync('.artifacts',{recursive:true});writeFileSync('.artifacts/routing-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));if(report.status!=='PASSED')process.exitCode=1
