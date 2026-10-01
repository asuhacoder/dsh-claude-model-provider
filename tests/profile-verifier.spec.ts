import { describe, expect, it } from 'vitest'
import { MAX_PROFILE_DUMP_BYTES, verifyProfileTransition } from '../src/profile-verifier.js'

const before = `# == base
- id: security-policy
  name: policy
  config:
    gate: strict
- id: agent-default-model
  name: model-selector
  config:
    provider: deepseek
    model: default
- id: session-store
  name: storage
  config:
    root: !!js process.env.DSH_HOME
`

const installed = `# == base
- id: security-policy
  name: policy
  config:
    gate: strict
- id: agent-default-model
  name: model-selector
  config:
    provider: deepseek
    model: default
- id: session-store
  name: storage
  config:
    root: !!js process.env.DSH_HOME
# == dsh-claude-plugin
- id: llm-claude-sdk-local
  name: '@asuha/dsh-claude-model-provider'
`

describe('DSH profile dump verifier', () => {
  it('accepts only the adapter insertion/default-model change and exact removal', () => {
    const report = verifyProfileTransition(before, installed, before)
    expect(report).toEqual({
      schemaVersion: 1,
      pass: true,
      beforeRows: 3,
      installedRows: 4,
      removedRows: 3,
      allowedChangedRowIds: ['llm-claude-sdk-local'],
      issues: [],
    })
  })

  it('rejects changes to security, tool, session, or unexpected rows', () => {
    const policyChanged = installed.replace('gate: strict', 'gate: disabled')
    expect(verifyProfileTransition(before, policyChanged).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PROFILE_ROW_CHANGED',
          summary: expect.stringContaining('security-policy'),
        }),
      ]),
    )

    const extra = `${installed}- id: native-shell-bypass\n  name: unsafe\n`
    expect(verifyProfileTransition(before, extra).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_ROW_ADDED' })]),
    )

    const missing = installed.replace(/- id: session-store[\s\S]*?process\.env\.DSH_HOME\n/, '')
    expect(verifyProfileTransition(before, missing).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_ROW_MISSING' })]),
    )
  })

  it('rejects wrong adapter/model shapes and incomplete removal', () => {
    expect(
      verifyProfileTransition(before, installed.replace("name: '@asuha/dsh-claude-model-provider'", 'name: other'))
        .issues,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_CLAUDE_ROW_INVALID' })]),
    )
    expect(
      verifyProfileTransition(before, installed.replace('model: default\n', 'model: opus\n'))
        .issues,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_DEFAULT_MODEL_INVALID' })]),
    )
    expect(verifyProfileTransition(before, installed, installed).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_REMOVE_ROW_REMAINS' })]),
    )
  })

  it('rejects reordered install and removal trees even when row contents match', () => {
    const reorderedInstall = installed.replace(
      /(- id: agent-default-model[\s\S]*?model: default\n)(- id: session-store[\s\S]*?process\.env\.DSH_HOME\n)/,
      '$2$1',
    )
    expect(verifyProfileTransition(before, reorderedInstall).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_ROW_ORDER_CHANGED' })]),
    )

    const reorderedRemoval = before.replace(
      /(- id: security-policy[\s\S]*?gate: strict\n)(- id: agent-default-model[\s\S]*?model: default\n)/,
      '$2$1',
    )
    expect(verifyProfileTransition(before, installed, reorderedRemoval).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_REMOVE_ORDER_CHANGED' })]),
    )
  })

  it('fails closed for malformed, repeated, non-array, and oversized dumps', () => {
    expect(verifyProfileTransition('not: an array', installed).issues[0]?.code).toBe(
      'PROFILE_BEFORE_INVALID',
    )
    expect(
      verifyProfileTransition('- id: same\n- id: same\n', installed).issues[0]?.summary,
    ).toMatch(/repeats row ID/)
    expect(verifyProfileTransition('!unsupported value\n', installed).issues[0]?.code).toBe(
      'PROFILE_BEFORE_INVALID',
    )
    expect(
      verifyProfileTransition(
        `- id: x\n  value: ${'x'.repeat(MAX_PROFILE_DUMP_BYTES)}\n`,
        installed,
      ).issues[0]?.summary,
    ).toMatch(/exceeds/)
  })

  it('rejects invalid YAML rows and every invalid ID boundary', () => {
    expect(verifyProfileTransition('- id: [\n', installed).issues[0]?.summary).toMatch(/valid YAML/)
    for (const invalid of [
      '- scalar\n',
      '- [array-row]\n',
      '- name: missing-id\n',
      '- id: ""\n',
      `- id: ${'x'.repeat(257)}\n`,
      '- id: "bad\\u007fid"\n',
    ]) {
      expect(verifyProfileTransition(invalid, installed).issues[0]?.code).toBe(
        'PROFILE_BEFORE_INVALID',
      )
    }
  })

  it('reports baseline, adapter, default-model, and removal boundary failures', () => {
    const baselineWithClaude = `${before}- id: llm-claude-sdk-local\n  name: existing\n`
    expect(verifyProfileTransition(baselineWithClaude, installed).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PROFILE_BASELINE_ALREADY_HAS_CLAUDE' }),
      ]),
    )

    const noDefault = before.replace(/- id: agent-default-model[\s\S]*?model: default\n/, '')
    expect(verifyProfileTransition(noDefault, installed).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PROFILE_BASELINE_DEFAULT_MODEL_MISSING' }),
      ]),
    )

    const noAdapter = installed.replace(/# == dsh-claude-plugin[\s\S]*$/, '')
    expect(verifyProfileTransition(before, noAdapter).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_CLAUDE_ROW_INVALID' })]),
    )

    const noInstalledDefault = installed.replace(
      /- id: agent-default-model[\s\S]*?model: default\n/,
      '',
    )
    expect(verifyProfileTransition(before, noInstalledDefault).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_DEFAULT_MODEL_INVALID' })]),
    )

    const removedMissing = before.replace(/- id: session-store[\s\S]*$/, '')
    expect(verifyProfileTransition(before, installed, removedMissing).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_REMOVE_ROW_MISSING' })]),
    )

    const removedChanged = before.replace('gate: strict', 'gate: changed')
    expect(verifyProfileTransition(before, installed, removedChanged).issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_REMOVE_ROW_CHANGED' })]),
    )

    expect(verifyProfileTransition(before, installed, '- id: [\n').issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PROFILE_REMOVED_INVALID' })]),
    )
  })
})
