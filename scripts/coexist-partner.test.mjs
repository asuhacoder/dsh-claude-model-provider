import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decidePartnerFailure } from './coexist-partner.mjs'

const partner = 'dsh-plugin-subscriptions@0.9.11'
const rejected = [
  'dsh: installation rejected: Plugin dsh-plugin-subscriptions@0.9.11 is incompatible with dsh 0.2.2-alpha.2:',
  'requirements {"@deepseek-ai/dsh-llm":"^0.1.1-rc.2 || ^0.1.2-alpha.1 || ^0.1.3-alpha.1 || ^0.1.5-alpha.1 || ^0.1.7-rc.1 || 0.2.0-rc.2 || 0.2.1-alpha.2 || 0.2.1-alpha.3 || 0.2.1-rc.2 || 0.2.1-rc.3","@deepseek-ai/dsh-web":"^0.1.1-rc.2 || ^0.1.2-alpha.1 || ^0.1.3-alpha.1 || ^0.1.5-alpha.1 || ^0.1.7-rc.1 || 0.2.0-rc.2 || 0.2.1-alpha.2 || 0.2.1-alpha.3 || 0.2.1-rc.2 || 0.2.1-rc.3","@deepseek-ai/dsh-tools":"^0.1.1-rc.2 || ^0.1.2-alpha.1 || ^0.1.3-alpha.1 || ^0.1.5-alpha.1 || ^0.1.7-rc.1 || 0.2.0-rc.2 || 0.2.1-alpha.2 || 0.2.1-alpha.3 || 0.2.1-rc.2 || 0.2.1-rc.3","@deepseek-ai/dsh-attachment":"^0.1.1-rc.2 || ^0.1.2-alpha.1 || ^0.1.3-alpha.1 || ^0.1.5-alpha.1 || ^0.1.7-rc.1 || 0.2.0-rc.2 || 0.2.1-alpha.2 || 0.2.1-alpha.3 || 0.2.1-rc.2 || 0.2.1-rc.3","@deepseek-ai/dsh-home-paths":"^0.1.1-rc.2 || ^0.1.2-alpha.1 || ^0.1.3-alpha.1 || ^0.1.5-alpha.1 || ^0.1.7-rc.1 || 0.2.0-rc.2 || 0.2.1-alpha.2 || 0.2.1-alpha.3 || 0.2.1-rc.2 || 0.2.1-rc.3"}.',
  'Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime.',
  'To accept this risk explicitly, grant the exact-version exemption for dsh-plugin-subscriptions@0.9.11 on dsh 0.2.2-alpha.2 with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh.',
  'Exact-version exemption: not active.',
  'dsh: nothing was installed.',
].join(' ')

test('a candidate defers when dsh rejects only the coexist partner', () => {
  const decision = decidePartnerFailure({
    output: rejected,
    pluginSpec: partner,
    candidate: true,
  })
  assert.equal(decision.action, 'defer')
  assert.equal(decision.plugin, partner)
  assert.match(decision.detail, /dsh-plugin-subscriptions@0\.9\.11/)
  assert.match(decision.detail, /0\.2\.2-alpha\.2/)
  assert.match(decision.detail, /"@deepseek-ai\/dsh-llm"/)
  assert.match(decision.detail, /0\.2\.1-rc\.3/)
  assert.doesNotMatch(decision.detail, /allow-version/)
})

test('the pinned host still fails when the same partner is rejected', () => {
  const decision = decidePartnerFailure({
    output: rejected,
    pluginSpec: partner,
    candidate: false,
  })
  assert.equal(decision.action, 'fail')
  assert.equal(decision.detail, undefined)
})

test('a candidate fails when dsh rejects this provider', () => {
  const output = rejected.replaceAll(
    partner,
    '@asuha/dsh-claude-model-provider@0.1.0-next.5',
  )
  const decision = decidePartnerFailure({
    output,
    pluginSpec: partner,
    candidate: true,
  })
  assert.equal(decision.action, 'fail')
})

test('a candidate fails when the rejected version is not the one just added', () => {
  const decision = decidePartnerFailure({
    output: rejected,
    pluginSpec: 'dsh-plugin-subscriptions@0.9.12',
    candidate: true,
  })
  assert.equal(decision.action, 'fail')
})

test('a candidate fails when the install dies for another reason', () => {
  const decision = decidePartnerFailure({
    output: 'npm ERR! network request to https://registry.npmjs.org/dsh-plugin-subscriptions failed',
    pluginSpec: partner,
    candidate: true,
  })
  assert.equal(decision.action, 'fail')
})

test('a candidate fails when two plugins are rejected together', () => {
  const output = `${rejected} Plugin @asuha/dsh-claude-model-provider@0.1.0-next.5 is incompatible with dsh 0.2.2-alpha.2: requirements {"@deepseek-ai/dsh-llm":"0.2.1-rc.2"}. Running it may cause crashes or data loss.`
  const decision = decidePartnerFailure({
    output,
    pluginSpec: partner,
    candidate: true,
  })
  assert.equal(decision.action, 'fail')
})

test('a chopped rejection is not enough to defer', () => {
  const decision = decidePartnerFailure({
    output: rejected.slice(0, 350),
    pluginSpec: partner,
    candidate: true,
  })
  assert.equal(decision.action, 'fail')
})
