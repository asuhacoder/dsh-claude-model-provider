import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyCandidate, assessUpstream, fingerprint, followedTag } from './upstream-line.mjs'

const dshIntegrity =
  'sha512-mdcpgF8D1eFQV8Gu3T/sYLkBwfw9h/Li0uPIxXyby1VybJgrFg8BU1Le40FiMnN+heL7k3zOMuAVe7sFq/JO4w=='
const sdkIntegrity =
  'sha512-InL/UNmRGSwBM/81PME0J0TZDsDBBlweWqRZgq2XSViSIg2hBi8nIL8j9Hm6MHRH85wgDJQE5n6Vo/r9hIO0NQ=='
const subIntegrity =
  'sha512-QiFoVFtCL9CawI5p8lKM2lfH2Lr95nMp6xyjBaEUpZxSae9MehGSaogX7G41rf965vVjVn0EQqJ0nPoFP1LA8Q=='
const sha = '687f282e8625c6b8d11ff58211a90524be2e4317'

function lock() {
  return {
    packages: {
      '@deepseek-ai/dsh': {
        version: '0.2.2-alpha.2',
        distTags: { alpha: '0.2.2-alpha.2', latest: '0.2.1-rc.2', next: '0.2.1-rc.4' },
        integrity: dshIntegrity,
      },
      '@anthropic-ai/claude-agent-sdk': {
        version: '0.3.286',
        distTags: { latest: '0.3.286', next: '0.3.287' },
        integrity: sdkIntegrity,
      },
      'dsh-plugin-subscriptions': {
        version: '0.9.10',
        distTags: { latest: '0.9.10' },
        integrity: subIntegrity,
      },
    },
    defaultBranchSha: sha,
  }
}

function packuments() {
  return {
    '@deepseek-ai/dsh': {
      'dist-tags': { alpha: '0.2.2-alpha.2', latest: '0.2.1-rc.2', next: '0.2.1-rc.4' },
      versions: {
        '0.2.2-alpha.2': {
          dist: { integrity: dshIntegrity },
          dependencies: {
            '@deepseek-ai/cordis': '~4.0.6-alpha.1',
            '@deepseek-ai/schemastery': '~3.18.6-alpha.1',
          },
        },
        '0.2.1-rc.2': {
          dist: { integrity: 'sha512-rc2' },
          dependencies: {
            '@deepseek-ai/cordis': '~4.0.5',
            '@deepseek-ai/schemastery': '~3.18.5',
          },
        },
      },
    },
    '@anthropic-ai/claude-agent-sdk': {
      'dist-tags': { latest: '0.3.286', next: '0.3.287' },
      versions: {
        '0.3.286': { dist: { integrity: sdkIntegrity } },
        '0.3.287': { dist: { integrity: 'sha512-nextsdk' } },
      },
    },
    'dsh-plugin-subscriptions': {
      'dist-tags': { latest: '0.9.10' },
      versions: { '0.9.10': { dist: { integrity: subIntegrity } } },
    },
  }
}

function manifest() {
  return {
    dependencies: {
      '@anthropic-ai/claude-agent-sdk': '0.3.286',
      '@deepseek-ai/schemastery': '^3.18.5 || ~3.18.6-alpha.1',
      yaml: '2.9.0',
    },
    devDependencies: {
      '@deepseek-ai/cordis': '4.0.6-alpha.1',
      '@deepseek-ai/dsh-llm': '0.2.2-alpha.2',
      '@deepseek-ai/dsh-timeout': '0.2.2-alpha.2',
    },
    peerDependencies: {
      '@deepseek-ai/cordis': '^4.0.4 || ~4.0.6-alpha.1',
      '@deepseek-ai/dsh-llm': '>=0.2.0-rc.2 <0.3.0-0',
    },
  }
}

test('followed tag is the locked version, alpha before next before latest', () => {
  assert.equal(
    followedTag({ alpha: '0.2.2-alpha.2', latest: '0.2.1-rc.2', next: '0.2.1-rc.4' }, '0.2.2-alpha.2'),
    'alpha',
  )
  assert.equal(followedTag({ latest: '0.3.286', next: '0.3.287' }, '0.3.286'), 'latest')
  assert.equal(
    followedTag({ latest: '0.2.0-rc.2', next: '0.2.0-rc.2', alpha: '0.2.0-rc.2' }, '0.2.0-rc.2'),
    'alpha',
  )
  assert.equal(followedTag({ latest: '0.2.1-rc.4', next: '0.2.1-rc.4' }, '0.2.1-rc.4'), 'next')
  assert.equal(
    followedTag({ 'dsh-0-2-1-alpha-1': '3.18.5-alpha.1', latest: '3.18.5' }, '3.18.5-alpha.1'),
    'dsh-0-2-1-alpha-1',
  )
  assert.equal(followedTag({ latest: '0.2.1-rc.2' }, '0.2.2-alpha.2'), null)
})

test('unchanged followed line is not a change when latest differs and the lock has no next field', () => {
  const result = assessUpstream({ lock: lock(), packuments: packuments(), defaultBranchSha: sha })
  assert.equal(result.changed, false)
  assert.equal(result.packages['@deepseek-ai/dsh'].version, '0.2.2-alpha.2')
  assert.equal(result.packages['@deepseek-ai/dsh'].tag, 'alpha')
  assert.equal(result.lines['@deepseek-ai/schemastery'], '~3.18.6-alpha.1')
  assert.equal(result.lines['@deepseek-ai/cordis'], '~4.0.6-alpha.1')
  assert.equal(result.packages['@deepseek-ai/dsh'].next, undefined)
})

test('a move of npm latest does not change the alpha line or its fingerprint', () => {
  const before = assessUpstream({ lock: lock(), packuments: packuments(), defaultBranchSha: sha })
  const live = packuments()
  live['@deepseek-ai/dsh']['dist-tags'].latest = '0.2.1-rc.9'
  const after = assessUpstream({ lock: lock(), packuments: live, defaultBranchSha: sha })
  assert.equal(after.changed, false)
  assert.equal(after.packages['@deepseek-ai/dsh'].version, '0.2.2-alpha.2')
  assert.equal(fingerprint(after), fingerprint(before))
})

test('a move of the followed alpha tag is a change and carries that release line', () => {
  const live = packuments()
  live['@deepseek-ai/dsh']['dist-tags'].alpha = '0.2.2-alpha.3'
  live['@deepseek-ai/dsh'].versions['0.2.2-alpha.3'] = {
    dist: { integrity: 'sha512-alpha3' },
    dependencies: {
      '@deepseek-ai/cordis': '~4.0.7-alpha.1',
      '@deepseek-ai/schemastery': '~3.18.7-alpha.1',
    },
  }
  const result = assessUpstream({ lock: lock(), packuments: live, defaultBranchSha: sha })
  assert.equal(result.changed, true)
  assert.equal(result.packages['@deepseek-ai/dsh'].version, '0.2.2-alpha.3')
  assert.equal(result.packages['@deepseek-ai/dsh'].tag, 'alpha')
  assert.equal(result.lines['@deepseek-ai/schemastery'], '~3.18.7-alpha.1')
  assert.equal(result.lines['@deepseek-ai/cordis'], '~4.0.7-alpha.1')
})

test('sdk latest, subscriptions latest, and the harness sha are changes while dsh stays on alpha', () => {
  const live = packuments()
  live['@anthropic-ai/claude-agent-sdk']['dist-tags'].latest = '0.3.312'
  live['@anthropic-ai/claude-agent-sdk']['dist-tags'].next = '0.3.312'
  live['@anthropic-ai/claude-agent-sdk'].versions['0.3.312'] = { dist: { integrity: 'sha512-sdk312' } }
  live['dsh-plugin-subscriptions']['dist-tags'].latest = '0.9.11'
  live['dsh-plugin-subscriptions'].versions['0.9.11'] = { dist: { integrity: 'sha512-sub11' } }
  const result = assessUpstream({
    lock: lock(),
    packuments: live,
    defaultBranchSha: 'f3803c96974ad4a94195fb97e5c637e9c2a3afe3',
  })
  assert.equal(result.changed, true)
  assert.equal(result.packages['@deepseek-ai/dsh'].version, '0.2.2-alpha.2')
  assert.equal(result.packages['@anthropic-ai/claude-agent-sdk'].version, '0.3.312')
  assert.equal(result.packages['@anthropic-ai/claude-agent-sdk'].tag, 'latest')
  assert.equal(result.packages['dsh-plugin-subscriptions'].version, '0.9.11')
  assert.equal(result.lines['@deepseek-ai/schemastery'], '~3.18.6-alpha.1')
})

test('republished integrity is a change', () => {
  const live = packuments()
  live['@deepseek-ai/dsh'].versions['0.2.2-alpha.2'].dist.integrity = 'sha512-republish'
  const result = assessUpstream({ lock: lock(), packuments: live, defaultBranchSha: sha })
  assert.equal(result.packages['@deepseek-ai/dsh'].version, '0.2.2-alpha.2')
  assert.equal(result.changed, true)
})

test('a lock version that matches no dist-tag is refused', () => {
  const broken = lock()
  broken.packages['@deepseek-ai/dsh'].version = '9.9.9'
  broken.packages['@deepseek-ai/dsh'].distTags = { latest: '0.2.1-rc.2' }
  assert.throws(
    () => assessUpstream({ lock: broken, packuments: packuments(), defaultBranchSha: sha }),
    /UNTRACKED_LINE/,
  )
})

test('a followed tag that disappeared is refused', () => {
  const live = packuments()
  delete live['@deepseek-ai/dsh']['dist-tags'].alpha
  assert.throws(
    () => assessUpstream({ lock: lock(), packuments: live, defaultBranchSha: sha }),
    /TAG_MISSING/,
  )
})

test('candidate install pins one dsh line and leaves the input manifest alone', () => {
  const assessed = assessUpstream({ lock: lock(), packuments: packuments(), defaultBranchSha: sha })
  const source = manifest()
  const pinned = applyCandidate(source, assessed)
  assert.equal(pinned.devDependencies['@deepseek-ai/dsh-llm'], '0.2.2-alpha.2')
  assert.equal(pinned.devDependencies['@deepseek-ai/dsh-timeout'], '0.2.2-alpha.2')
  assert.equal(pinned.dependencies['@deepseek-ai/schemastery'], '~3.18.6-alpha.1')
  assert.equal(pinned.devDependencies['@deepseek-ai/cordis'], '~4.0.6-alpha.1')
  assert.equal(pinned.peerDependencies['@deepseek-ai/cordis'], '~4.0.6-alpha.1')
  assert.equal(pinned.peerDependencies['@deepseek-ai/dsh-llm'], '0.2.2-alpha.2')
  assert.equal(pinned.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.286')
  assert.equal(pinned.dependencies.yaml, '2.9.0')
  assert.equal(source.dependencies['@deepseek-ai/schemastery'], '^3.18.5 || ~3.18.6-alpha.1')
  assert.deepEqual(applyCandidate(pinned, assessed), pinned)
})

test('a candidate for a moved sdk does not pull the older latest dsh line', () => {
  const live = packuments()
  live['@anthropic-ai/claude-agent-sdk']['dist-tags'].latest = '0.3.312'
  live['@anthropic-ai/claude-agent-sdk'].versions['0.3.312'] = { dist: { integrity: 'sha512-sdk312' } }
  const assessed = assessUpstream({ lock: lock(), packuments: live, defaultBranchSha: sha })
  const pinned = applyCandidate(
    {
      dependencies: {
        '@anthropic-ai/claude-agent-sdk': '0.3.286',
        '@deepseek-ai/schemastery': '^3.18.5 || ~3.18.6-alpha.1',
      },
      devDependencies: {
        '@deepseek-ai/dsh-llm': '0.2.2-alpha.2',
        '@deepseek-ai/cordis': '4.0.6-alpha.1',
      },
      peerDependencies: {},
    },
    assessed,
  )
  assert.equal(pinned.devDependencies['@deepseek-ai/dsh-llm'], '0.2.2-alpha.2')
  assert.equal(pinned.dependencies['@deepseek-ai/schemastery'], '~3.18.6-alpha.1')
  assert.equal(pinned.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.312')
})
