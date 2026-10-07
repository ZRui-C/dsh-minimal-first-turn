import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { evaluatePluginCompatibility, getDshRuntimeVersion, bundlePatchFiles } from '@deepseek-ai/dsh-app-boot'

const require = createRequire(import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const supported = ['0.2.0-rc.2', '0.2.1-alpha.1']

test('actual DSH compatibility gate accepts both verified runtimes without exemptions', () => {
  assert.ok(supported.includes(getDshRuntimeVersion()))
  assert.equal(evaluatePluginCompatibility(manifest), undefined)
  for (const version of supported) assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined)
})

test('peer contract still rejects unverified old and future runtime versions', () => {
  for (const version of ['0.1.0-rc.6', '0.2.0-rc.1', '0.2.0', '0.2.1', '0.3.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.equal(issue?.exempted, false)
    assert.deepEqual(Object.keys(issue.peers).sort(), Object.keys(manifest.peerDependencies).sort())
  }
})

test('test dependencies belong to the actual selected runtime rather than a mixed family', () => {
  const version = getDshRuntimeVersion()
  if (process.env.DSH_TEST_VERSION) assert.equal(version, process.env.DSH_TEST_VERSION)
  for (const name of Object.keys(manifest.devDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
    assert.equal(require(`${name}/package.json`).version, version, `${name} must match tested runtime`)
  }
  assert.equal(require('@deepseek-ai/cordis/package.json').version, version === '0.2.0-rc.2' ? '4.0.4' : '4.0.5-alpha.1')
})

test('real app-boot bundle metadata resolves shipped host, client and patch files', () => {
  assert.deepEqual(bundlePatchFiles(manifest.dsh.bundle), ['./cordis.patch.yml'])
  for (const path of [manifest.main, manifest.exports['./client'], ...bundlePatchFiles(manifest.dsh.bundle)]) {
    assert.ok(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').length > 0)
  }
  assert.match(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), /name: dsh-minimal-first-turn/)
})
