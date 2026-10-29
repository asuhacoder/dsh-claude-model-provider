export function decidePartnerFailure({ output, pluginSpec, candidate }) {
  if (candidate !== true) return { action: 'fail' }
  if (typeof output !== 'string' || typeof pluginSpec !== 'string' || pluginSpec.length === 0) {
    return { action: 'fail' }
  }
  if (!output.includes('installation rejected:')) return { action: 'fail' }
  const plugins = [...output.matchAll(/Plugin (\S+) is incompatible with dsh /g)].map((match) => match[1])
  if (plugins.length !== 1 || plugins[0] !== pluginSpec) return { action: 'fail' }
  const lead = `installation rejected: Plugin ${pluginSpec} is incompatible with dsh `
  const at = output.indexOf(lead)
  if (at < 0) return { action: 'fail' }
  const body = output.slice(at + 'installation rejected: '.length)
  const stop = body.indexOf('. Running it may cause')
  if (stop < 0) return { action: 'fail' }
  return { action: 'defer', plugin: pluginSpec, detail: body.slice(0, stop) }
}
