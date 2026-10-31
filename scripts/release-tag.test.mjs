import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessReleaseTag, changelogSection } from './release-tag.mjs'

const changelog = `# Changelog

## Unreleased

Pending work.

## 0.1.0-next.7 — 2026-11-01

Publish from a version tag.

Second paragraph.

## 0.1.0-next.6 — 2026-10-17

Older entry.
`

function input(overrides = {}) {
  return {
    ref: 'refs/tags/v0.1.0-next.7',
    version: '0.1.0-next.7',
    changelog,
    publishedVersions: ['0.1.0-next.5', '0.1.0-next.6'],
    ...overrides,
  }
}

test('accepts a prerelease tag that matches package.json and returns its notes', () => {
  assert.deepEqual(assessReleaseTag(input()), {
    version: '0.1.0-next.7',
    distTag: 'next',
    notes: 'Publish from a version tag.\n\nSecond paragraph.',
  })
})

test('rejects a tag that differs from package.json', () => {
  assert.throws(() => assessReleaseTag(input({ ref: 'refs/tags/v0.1.0-next.8' })), { code: 'TAG_VERSION_MISMATCH' })
  assert.throws(() => assessReleaseTag(input({ ref: 'refs/heads/main' })), { code: 'TAG_VERSION_MISMATCH' })
})

test('leaves stable versions to manual promotion', () => {
  assert.throws(
    () => assessReleaseTag(input({ ref: 'refs/tags/v0.1.0', version: '0.1.0', changelog: '## 0.1.0\n\nStable.\n' })),
    { code: 'STABLE_RELEASE_IS_MANUAL' },
  )
})

test('refuses to republish an existing version', () => {
  assert.throws(
    () => assessReleaseTag(input({ ref: 'refs/tags/v0.1.0-next.6', version: '0.1.0-next.6' })),
    { code: 'VERSION_ALREADY_PUBLISHED' },
  )
})

test('requires a non-empty changelog section for the exact version', () => {
  assert.throws(() => assessReleaseTag(input({ changelog: '## Unreleased\n\nPending.\n' })), {
    code: 'CHANGELOG_ENTRY_MISSING',
  })
  assert.throws(() => assessReleaseTag(input({ changelog: '## 0.1.0-next.7\n\n## 0.1.0-next.6\n\nOld.\n' })), {
    code: 'CHANGELOG_ENTRY_MISSING',
  })
})

test('does not match a version that only shares a prefix', () => {
  assert.equal(changelogSection('## 0.1.0-next.70\n\nOther.\n', '0.1.0-next.7'), undefined)
})

test('rejects a version that is not semver', () => {
  assert.throws(() => assessReleaseTag(input({ ref: 'refs/tags/vnext', version: 'next' })), { code: 'INVALID_VERSION' })
})
