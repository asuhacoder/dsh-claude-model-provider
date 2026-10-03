import {execFileSync} from 'node:child_process'
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
mkdirSync('dist',{recursive:true});mkdirSync('.artifacts',{recursive:true});const report=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination','dist'],{encoding:'utf8'}))[0]
const digest=createHash('sha256').update(readFileSync('dist/'+report.filename)).digest('hex')
const r={status:'PASSED',dryRunOnly:true,package:report.name,version:report.version,tag:'next',sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tarball:'dist/'+report.filename,artifactSha256:digest,nextPublish:'NOT_ATTEMPTED',latestPromotion:'BLOCKED',reason:'publication_requires_verified_artifact_and_maintainer_authentication_or_trusted_publisher'}
writeFileSync('.artifacts/release-dry-run.json',JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify(r))
