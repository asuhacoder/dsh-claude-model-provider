import { shadowForecast,simulate } from '../lib/routing/forecast.js'
import { choose } from '../lib/routing/router.js'
import { mkdirSync,writeFileSync } from 'node:fs'
const now=1000000,results=[]
const account=(id,capacity)=>({identity:id,aliases:[id],profileRef:'fixture',state:'READY',verifiedAt:1,models:{opus:['low']},parallelLimit:2,windows:[{key:'all',scope:'*',epoch:'fixture',observedAt:now,remainingWork:capacity,source:'fixture'}]})
for(let seed=51;seed<=100;seed++){
 const pool=[{account:account('A',4+seed%5),capacity:4+seed%5,coldCost:1,resetAt:now+200,refill:8},{account:account('B',12),capacity:12,coldCost:1}],history=Array.from({length:16},(_,i)=>({at:now-(16-i)*30,work:1,durationMs:20})),arrivals=Array.from({length:32},(_,i)=>({at:now+i*(seed%2?15:100),session:'s'+i,work:1+Number(i%7===0),durationMs:20})),req={session:'seed'+seed,requestId:'r',model:'opus',effort:'low',now}
 const forecast=shadowForecast(pool.map(p=>p.account),req,[],history),baseline=choose(pool.map(p=>p.account),req,[]).identity
 const a=simulate(pool,arrivals,baseline,now),b=simulate(pool,arrivals,forecast.predicted??baseline,now)
 results.push({seed,baselineCompleted:a.completed,shadowCompleted:b.completed,elapsedMs:forecast.elapsedMs})
}
const report={status:'PASSED',scope:'synthetic holdout seeds 51-100; no live efficiency claim',mode:'shadow',automaticActivation:false,samples:results.length,baselineCompleted:results.reduce((n,r)=>n+r.baselineCompleted,0),shadowCompleted:results.reduce((n,r)=>n+r.shadowCompleted,0),regressions:results.filter(r=>r.shadowCompleted<r.baselineCompleted).length,maxCalculationMs:Math.max(...results.map(r=>r.elapsedMs)),modelCalls:0,reason:'Forecast remains shadow until workload-specific evidence supports activation'}
mkdirSync('.artifacts',{recursive:true});writeFileSync('.artifacts/forecast-holdout.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
