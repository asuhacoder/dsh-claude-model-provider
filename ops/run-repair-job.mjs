// Maintainer-owned entry point. Never invoke from candidate code or a public PR runner.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  renameSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { repairCycle } from './pipeline.mjs'
const job = JSON.parse(readFileSync(process.argv[2], 'utf8')),
  configPath = process.env.DSH_REPAIR_RUNNER_CONFIG
if (!configPath) {
  console.log(JSON.stringify({ status: 'BLOCKED', reason: 'independent_services_not_deployed' }))
  process.exit(2)
}
const config = JSON.parse(readFileSync(configPath, 'utf8'))
if (config.isolationAttested !== true || !config.verifierPublicKey || !config.stateDirectory)
  throw new Error('INDEPENDENT_SERVICES_REQUIRED')
for (const name of ['compatibility', 'worker', 'verifier', 'publisher']) {
  const service = config[name]
  if (
    !service ||
    !Array.isArray(service.command) ||
    !service.command.length ||
    !service.cwd ||
    !service.home
  )
    throw new Error('MISSING_SERVICE')
  if (
    name !== 'publisher' &&
    (service.credentialEnv ?? []).some((k) => /GITHUB|GH_TOKEN|NPM|NODE_AUTH|SIGNING/i.test(k))
  )
    throw new Error('CREDENTIAL_BOUNDARY_REJECTED')
}
const state = resolve(config.stateDirectory)
mkdirSync(state, { recursive: true, mode: 0o700 })
const lock = join(state, 'active.lock'),
  fd = openSync(lock, 'wx', 0o600)
writeFileSync(fd, JSON.stringify({ pid: process.pid }))
closeSync(fd)
let registry = {}
const call = (name, input) =>
  new Promise((resolve, reject) => {
    const service = config[name],
      env = { HOME: service.home, USERPROFILE: service.home }
    for (const key of ['PATH', 'SystemRoot', ...(service.credentialEnv ?? [])])
      if (process.env[key] !== undefined) env[key] = process.env[key]
    const child = spawn(service.command[0], service.command.slice(1), {
      cwd: service.cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
    })
    let bytes = 0,
      text = ''
    const timer = setTimeout(
      () => child.kill('SIGKILL'),
      Math.max(1, Math.min(600000, job.deadline - Date.now())),
    )
    child.stdout.on('data', (b) => {
      bytes += b.length
      if (bytes > 262144) {
        child.kill('SIGKILL')
        return
      }
      text += b.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      reject(new Error(name.toUpperCase() + '_START_FAILED'))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0 || bytes > 262144) {
        reject(new Error(name.toUpperCase() + '_FAILED'))
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error(name.toUpperCase() + '_INVALID_RESPONSE'))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
try {
  try {
    registry = JSON.parse(readFileSync(join(state, 'jobs.json'), 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const result = await repairCycle(
    job,
    {
      now: Date.now,
      verifierPublicKey: config.verifierPublicKey,
      compatibility: (j) => call('compatibility', j),
      worker: (j) => call('worker', j),
      verifier: (j) => call('verifier', j),
      publisher: (j) => call('publisher', j),
    },
    registry,
  )
  console.log(JSON.stringify(result))
  if (['BLOCKED', 'HUMAN_REVIEW'].includes(result.status)) process.exitCode = 2
} finally {
  const temp = join(state, 'jobs.next.json')
  writeFileSync(temp, JSON.stringify(registry), { mode: 0o600 })
  renameSync(temp, join(state, 'jobs.json'))
  unlinkSync(lock)
}
