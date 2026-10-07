// Select a test dependency family without changing the published peer contract.
import { readFileSync, writeFileSync } from 'node:fs'
const versions = {
  '0.2.0-rc.2': { cordis: '4.0.4', group: '1.0.4', include: '1.0.9', loader: '1.0.5' },
  '0.2.1-alpha.1': { cordis: '4.0.5-alpha.1', group: '1.0.5-alpha.1', include: '1.0.10-alpha.1', loader: '1.0.6-alpha.1' },
}
const version = process.argv[2]
if (!Object.hasOwn(versions, version)) throw new Error(`Unsupported test runtime: ${version}`)
const path = new URL('../package.json', import.meta.url)
const manifest = JSON.parse(readFileSync(path, 'utf8'))
for (const name of Object.keys(manifest.devDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) manifest.devDependencies[name] = version
}
manifest.devDependencies['@deepseek-ai/cordis'] = versions[version].cordis
for (const name of ['group', 'include', 'loader']) manifest.devDependencies[`@deepseek-ai/cordis-plugin-${name}`] = versions[version][name]
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Selected DSH ${version}, Cordis ${versions[version].cordis} for tests; peerDependencies unchanged.`)
