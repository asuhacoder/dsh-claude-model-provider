import { spawn } from 'node-pty'
import { profileEnvironment } from '../auth/official.js'
import type { ProfileRef } from '../login-view.js'

export interface LoginPtyExit {
  readonly exitCode: number
  readonly signal?: number
}

export interface LoginPty {
  write(bytes: string): void
  kill(): void
  onData(listener: (chunk: string) => void): void
  onExit(listener: (event: LoginPtyExit) => void): void
}

export function spawnLoginPty(command: string, profileRef: ProfileRef): LoginPty {
  const child = spawn(command, ['auth', 'login', '--claudeai'], {
    name: 'xterm-256color',
    cols: 200,
    rows: 24,
    env: profileEnvironment(profileRef),
  })
  return {
    write(bytes) {
      child.write(bytes)
    },
    kill() {
      if (process.platform === 'win32') child.kill()
      else child.kill('SIGKILL')
    },
    onData(listener) {
      child.onData(listener)
    },
    onExit(listener) {
      child.onExit(listener)
    },
  }
}
