/** Validate the assembled application, including native Office conversion outside ASAR. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'
import { resolveDesktopBuildPlugin } from './desktop-build-plugin.mjs'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
const plugin = resolveDesktopBuildPlugin(process.env)
const allowUnsignedMac = Boolean(plugin)
if (values.unsigned && !windows && (!allowUnsignedMac || !target.startsWith('mac-'))) throw new Error('desktop smoke: unsigned artifacts require Windows')
const artifacts = values.unsigned ? paths.unsignedArtifacts : paths.artifacts
const productName = plugin?.productName ?? 'DeepSeek Harness'
const runtimeDir = plugin?.runtimeDirName ?? 'dsh'

const macTargetDir = join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac')
const macAppName = existsSync(join(macTargetDir, `${productName}.app`))
  ? `${productName}.app`
  : (existsSync(join(macTargetDir, 'DeepSeek Harness.app')) ? 'DeepSeek Harness.app' : `${productName}.app`)
const application = windows ? join(artifacts, 'win-unpacked')
  : join(macTargetDir, macAppName, 'Contents')
const resources = join(application, windows ? 'resources' : 'Resources')
const winExeName = existsSync(join(application, `${productName}.exe`))
  ? `${productName}.exe`
  : (existsSync(join(application, 'DeepSeek Harness.exe')) ? 'DeepSeek Harness.exe' : `${productName}.exe`)
const macExeName = existsSync(join(application, 'MacOS', productName))
  ? productName
  : (existsSync(join(application, 'MacOS', 'DeepSeek Harness')) ? 'DeepSeek Harness' : productName)
const executable = windows ? join(application, winExeName) : join(application, 'MacOS', macExeName)
const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
  resolveDesktopPackageTarget(target))
if (windows && !values.unsigned) await verifyWindowsCode(application)
const asarRoot = existsSync(join(resources, 'app.asar', runtimeDir))
  ? join(resources, 'app.asar', runtimeDir)
  : (existsSync(join(resources, 'app.asar', 'veh')) ? join(resources, 'app.asar', 'veh') : join(resources, 'app.asar', 'dsh'))
await smokePreparedRuntime(asarRoot, executable, join(resources, 'runtime'), descriptor)
