/**
 * Pack the repository's source and documentation into one distributable
 * tarball.
 *
 * The archive carries what `git add -A` would stage — tracked files plus
 * untracked files that .gitignore does not exclude — so dependencies and build
 * output stay out while local edits get in. Unlike `release:pack`, which packs
 * publishable npm tarballs, this command snapshots the whole working tree of
 * the repository.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, isEntry } from './release/process.ts'

/** Where the tarball lands, relative to the repository root. */
const OUTPUT_DIRECTORY = 'dist'

/** Version declared by the root manifest. */
function rootVersion(root: string): string {
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const { version } = manifest as Record<string, unknown>
  if (typeof version !== 'string') throw new Error('pack-source: root package.json has no version')
  return version
}

/** Archive the repository working tree into dist/. */
function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const version = rootVersion(root)
  const shortSha = capture('git', ['rev-parse', '--short', 'HEAD'], { cwd: root })
  // The pack output itself is untracked, so only other changes mark the tree dirty.
  const dirty = capture('git', ['status', '--porcelain'], { cwd: root })
    .split('\n')
    .some(line => line !== '' && line !== `?? ${OUTPUT_DIRECTORY}/`)
    ? '-dirty'
    : ''
  const name = `deepseek-harness-v${version}-${shortSha}${dirty}.tar.gz`

  // Locally deleted tracked files would make tar fail, and earlier pack output
  // under dist/ must not feed itself back in, so both drop out of the list.
  const files = capture('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
    .split('\0')
    .filter(path => path !== '' && !path.startsWith(`${OUTPUT_DIRECTORY}/`) && existsSync(join(root, path)))

  mkdirSync(join(root, OUTPUT_DIRECTORY), { recursive: true })
  const output = join(root, OUTPUT_DIRECTORY, name)
  const tar = spawnSync('tar', ['-czf', output, '--null', '-T', '-'], { cwd: root, input: files.join('\0') })
  if (tar.error !== undefined) throw tar.error
  if (tar.status !== 0) throw new Error(`tar exited with ${String(tar.status)}:\n${String(tar.stderr)}`)

  const mebibytes = statSync(output).size / 1024 / 1024
  console.log(`pack-source: ${String(files.length)} files, ${mebibytes.toFixed(1)} MiB -> ${OUTPUT_DIRECTORY}/${name}`)
}

if (isEntry(import.meta.url)) main()
