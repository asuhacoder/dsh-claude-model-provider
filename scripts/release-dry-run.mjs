import {execFileSync} from 'node:child_process'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
mkdirSync('dist',{recursive:true});mkdirSync('.artifacts',{recursive:true});const report=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination','dist'],{encoding:'utf8'}))[0]
const digest=createHash('sha256').update(readFileSync('dist/'+report.filename)).digest('hex')
const r={status:'PASSED',dryRunOnly:true,tarball:'dist/'+report.filename,artifactSha256:digest,nextPublish:'BLOCKED',latestPromotion:'BLOCKED',reason:'npm_trusted_publisher_and_release_approval_required'}
writeFileSync('.artifacts/release-dry-run.json',JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify(r))
