#!/usr/bin/env node
/**
 * Re-apply the DSH 0.1.2-alpha.2 runtime compatibility layer to the built
 * bundles. The plugin targets DSH >=0.2.1-rc.2 in source; this script narrows
 * the *built* output so the same package also runs on a 0.1.2-alpha.2 host,
 * where a handful of host APIs differ (schemastery `.volatile()`, jobs
 * `owner`, settings registration, working-directory service, loopback peer
 * principal, client UI primitives).
 *
 * Usage: node scripts/apply-dsh-01x-compat.mjs [--check]
 *   --check   report whether the layer is applied without writing (exit 1 if not)
 *
 * Every rule is idempotent: an already-patched bundle is left untouched, a
 * missing anchor is reported as drift instead of silently producing a broken
 * bundle.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const checkOnly = process.argv.includes('--check')

/** A rule whose anchor disappeared: the bundled code drifted from what this layer expects. */
class Drift extends Error {}

/** @type {{id: string, apply: (text: string) => string | undefined}[]} */
const HOST_RULES = [
  {
    id: 'cosmokit-isVolatile',
    apply(text) {
      if (text.includes('cosmokit.volatile.write')) return undefined
      const anchor = 'import { isVolatile } from "@deepseek-ai/cosmokit";'
      if (!text.includes(anchor)) throw new Drift('cosmokit import')
      return text.replace(anchor, [
        'const __cosmokitWrite = Symbol.for("cosmokit.volatile.write");',
        'function isVolatile(value) { return typeof value === "object" && value !== null && __cosmokitWrite in value; }',
      ].join('\n'))
    },
  },
  {
    id: 'schemastery-volatile',
    apply(text) {
      if (!text.includes('.volatile()')) return undefined
      // 0.1.x schemastery exposes .extra() but not .volatile().
      return text.replaceAll('.volatile()', '.extra("volatile", true)')
    },
  },
  {
    id: 'loopback-peer-optional',
    apply(text) {
      const anchor = 'if (peer.principal.kind !== "owner") return {'
      const patched = 'if (peer !== void 0 && peer.principal.kind !== "owner") return {'
      if (text.includes(patched)) return undefined
      if (!text.includes(anchor)) throw new Drift('loopback peer guard')
      return text.replace(anchor, patched)
    },
  },
  {
    id: 'working-directory-fallback',
    apply(text) {
      const anchor = 'return resolve(await ctx.workingDirectory.ensure(agent, exec.signal), source.file_path);'
      const patched = 'return resolve((agent && agent.session && agent.session.header && typeof agent.session.header.cwd === "string" ? agent.session.header.cwd : process.cwd()), source.file_path);'
      if (text.includes(patched)) return undefined
      if (!text.includes(anchor)) throw new Drift('workingDirectory resolve')
      return text.replace(anchor, patched)
    },
  },
  {
    id: 'jobs-owner-shape',
    apply(text) {
      if (text.includes('owner: agent,')) return undefined
      const anchor = 'owner: agent.session.id,'
      if (!text.includes(anchor)) throw new Drift('jobs owner')
      return text.replace(anchor, 'owner: agent,')
    },
  },
  {
    id: 'jobs-progress-guard',
    apply(text) {
      if (text.includes('typeof job.updateProgress === "function"')) return undefined
      // Target the progress callback alone: the surrounding call keeps gaining arguments.
      const anchor = '(phase) => job.updateProgress(phase)'
      const patched = '(phase) => { if (job && typeof job.updateProgress === "function") job.updateProgress(phase); }'
      if (!text.includes(anchor)) throw new Drift('job.updateProgress callback')
      return text.replace(anchor, patched)
    },
  },
  {
    id: 'settings-read-preference',
    apply(text) {
      if (text.includes('function readRuntimeConfig(ctx, entryConfig) {\n\t// DSH 0.2.x')) return undefined
      const anchor = 'function readRuntimeConfig(ctx, entryConfig) {'
      if (!text.includes(anchor)) throw new Drift('readRuntimeConfig')
      const injected = [
        anchor,
        '\t// DSH 0.2.x updates the fiber config in place; 0.1.x keeps it immutable, so a',
        '\t// saved settings section is the live source when this compat layer registered one.',
        '\ttry {',
        '\t\tconst settings = ctx.get("settings");',
        '\t\tif (settings !== void 0 && typeof settings.get === "function") {',
        '\t\t\tconst fromSettings = settings.get("dsh-pdf-mineru");',
        '\t\t\tif (fromSettings !== void 0) return parseConfigWithMigration(configSnapshot(fromSettings)).config;',
        '\t\t}',
        '\t} catch (error) {',
        '\t\tif (!isInactiveContextError(error)) throw error;',
        '\t}',
      ].join('\n')
      return text.replace(anchor, injected)
    },
  },
  {
    id: 'settings-save-without-entry',
    apply(text) {
      if (text.includes('entry === void 0 ? "dsh-pdf-mineru" : entry.options.id')) return undefined
      const anchor = [
        'if (entry === void 0) throw new Error("MinerU configuration requires a Loader profile entry");',
        'const namespace = entry.options.id;',
        'const original = entry.options.config;',
      ].join('\n\t\t\t')
      if (!text.includes(anchor)) throw new Drift('settings save namespace')
      const patched = [
        '// 0.1.x fibers expose no Loader entry; persist through the settings namespace registered in apply().',
        'const namespace = entry === void 0 ? "dsh-pdf-mineru" : entry.options.id;',
        'const original = entry === void 0 ? void 0 : entry.options.config;',
      ].join('\n\t\t\t')
      return text.replace(anchor, patched)
    },
  },
  {
    id: 'settings-register-fallback',
    apply(text) {
      if (text.includes('typeof settings.register === "function"')) return undefined
      const anchor = 'ctx.effect(() => settings.configure({ auto: false }, ctx.fiber), "dsh-pdf-mineru settings presentation");'
      if (!text.includes(anchor)) throw new Drift('settings.configure')
      const patched = [
        'if (typeof settings.configure === "function") ctx.effect(() => settings.configure({ auto: false }, ctx.fiber), "dsh-pdf-mineru settings presentation");',
        '\telse if (typeof settings.register === "function") {',
        '\t\t// 0.1.x has no presentation wiring; register the entry config as a settings',
        '\t\t// namespace so the settings page can read and replace it, with the composed',
        '\t\t// entry as the base layer that fields saved from the page do not restate.',
        '\t\ttry {',
        '\t\t\tsettings.register("dsh-pdf-mineru", Config, { base: entryConfig });',
        '\t\t} catch (error) {',
        '\t\t\tif (!(error instanceof Error) || !/already registered/.test(error.message)) throw error;',
        '\t\t}',
        '\t}',
      ].join('\n')
      return text.replace(anchor, patched)
    },
  },
  {
    id: 'inject-without-working-directory',
    apply(text) {
      const anchor = '"settings",\n\t"workingDirectory"\n];'
      if (!text.includes(anchor)) return undefined
      return text.replace(anchor, '"settings"\n];')
    },
  },
]

let failures = 0
const hostPath = join(root, 'lib/index.js')
let host = readFileSync(hostPath, 'utf8')
for (const rule of HOST_RULES) {
  let next
  try {
    next = rule.apply(host)
  } catch (error) {
    if (!(error instanceof Drift)) throw error
    console.error(`DRIFT    ${rule.id}: anchor missing (${error.message})`)
    failures += 1
    continue
  }
  if (typeof next === 'string') {
    host = next
    console.log(`applied  ${rule.id}`)
  } else {
    console.log(`ok       ${rule.id} (already applied or not applicable)`)
  }
}
if (failures > 0) {
  console.error(`\n${failures} rule(s) could not be applied; the built bundle would not run on DSH 0.1.2-alpha.2.`)
  process.exit(1)
}
if (!checkOnly) writeFileSync(hostPath, host)
console.log(`\nhost layer ${checkOnly ? 'verified' : 'written'}: lib/index.js`)

// The client bundle needs a primitives shim plus a 0.1.x plugin-page slot; it is
// a stored unified diff so it survives unrelated source edits with `patch` fuzz.
const clientPath = join(root, 'lib/client.js')
const client = readFileSync(clientPath, 'utf8')
const clientApplied = client.includes('DSH 0.1.x compatibility')
if (clientApplied) {
  console.log('ok       client primitives shim (already applied)')
} else if (checkOnly) {
  console.error('DRIFT    client primitives shim is missing')
  process.exit(1)
} else {
  execFileSync('patch', ['-p1', '--no-backup-if-mismatch', '-i', join(root, 'patches/dsh-0.1.2-client.patch')], { cwd: root, stdio: 'inherit' })
  console.log('applied  client primitives shim')
}
