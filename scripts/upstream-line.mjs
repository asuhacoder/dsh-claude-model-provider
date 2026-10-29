const names = ['@deepseek-ai/dsh', '@anthropic-ai/claude-agent-sdk', 'dsh-plugin-subscriptions']

export function followedTag() {
  return 'latest'
}

export function assessUpstream({ lock, packuments, defaultBranchSha }) {
  const packages = {}
  for (const name of names) {
    const packument = packuments[name]
    const latest = packument['dist-tags'].latest
    const next = packument['dist-tags'].next
    packages[name] = {
      version: latest,
      next: next ?? null,
      distTags: packument['dist-tags'],
      integrity: packument.versions[latest].dist.integrity,
      nextIntegrity: next && packument.versions[next] ? packument.versions[next].dist.integrity : null,
    }
  }
  const changed =
    names.some(
      (name) =>
        lock?.packages?.[name]?.version !== packages[name].version ||
        lock?.packages?.[name]?.next !== packages[name].next,
    ) || lock?.defaultBranchSha !== defaultBranchSha
  return { changed, packages, lines: {}, defaultBranchSha }
}

export function fingerprint(assessed) {
  return JSON.stringify([assessed.packages, assessed.defaultBranchSha])
}

export function applyCandidate(manifest, tuple) {
  const dsh = tuple.packages['@deepseek-ai/dsh'].version
  const next = structuredClone(manifest)
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const name of Object.keys(next[group] ?? {})) {
      if (name.startsWith('@deepseek-ai/dsh-')) next[group][name] = dsh
      if (name === '@anthropic-ai/claude-agent-sdk') next[group][name] = tuple.packages[name].version
    }
  }
  return next
}
