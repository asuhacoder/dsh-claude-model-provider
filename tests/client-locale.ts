import { dictionaries, type Translate } from '../src/client/messages.js'

export function translator(language: keyof typeof dictionaries): Translate {
  return (key, params = {}) =>
    dictionaries[language][key].replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
      params[name] === undefined ? placeholder : String(params[name]),
    )
}

export const t = translator('ja')
