/**
 * VoiceEdge Harness (VEH) runtime environment and filesystem interceptor.
 *
 * Controls environment variables and user home directory requests,
 * converting them from DSH to VEH without modifying upstream code.
 *
 * @module @deepseek-ai/dsh-voice-edge/interceptor
 */

import { cpSync, existsSync } from 'node:fs'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Options configuring VEH environment and filesystem interception. */
export interface VehInterceptorOptions {
  /** Explicit VEH home override; defaults to process.env.VEH_HOME or ~/.veh. */
  vehHome?: string
  /** Disable automatic migration from ~/.dsh to ~/.veh when true. */
  skipMigration?: boolean
}

let installed = false
let uninstallFn: (() => void) | undefined

/**
 * Check whether the VEH interceptor is currently active.
 * @returns true if interceptor is installed.
 */
export function isVehInterceptorInstalled(): boolean {
  return installed
}

/**
 * Resolve the VEH home directory.
 * Strict isolation: only reads VEH_HOME, never falls back to DSH_HOME.
 * If unset, defaults to ~/.veh under the operating-system home.
 * @param env - Environment dictionary; defaults to process.env.
 * @returns Normalized absolute path to the VEH home directory.
 */
export function getVehHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VEH_HOME
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    const trimmed = fromEnv.trim()
    if (trimmed === '~') return homedir()
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
    return resolve(trimmed)
  }
  return join(homedir(), '.veh')
}

/**
 * Migrate existing ~/.dsh directory to ~/.veh if ~/.veh does not exist.
 * @param dshHome - Source ~/.dsh directory.
 * @param vehHome - Destination ~/.veh directory.
 */
export function migrateDshToVeh(dshHome: string, vehHome: string): void {
  try {
    if (!existsSync(vehHome) && existsSync(dshHome)) {
      cpSync(dshHome, vehHome, { recursive: true, errorOnExist: false })
    }
  } catch (err) {
    console.warn(`[veh-interceptor] Migration from ${dshHome} to ${vehHome} failed:`, err)
  }
}

/**
 * Detect user-configured npm/pnpm registry.
 * Reads environment variables first, then ~/.npmrc or .npmrc.
 * @param env - Environment dictionary; defaults to process.env.
 * @returns Clean HTTPS registry origin or undefined.
 */
export function detectUserNpmRegistry(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY
    ?? env.VEH_DESKTOP_NPM_REGISTRY ?? env.DSH_DESKTOP_NPM_REGISTRY
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    let reg = fromEnv.trim()
    if (reg.endsWith('/')) reg = reg.slice(0, -1)
    return reg
  }
  try {
    const homeNpmrc = join(homedir(), '.npmrc')
    if (existsSync(homeNpmrc)) {
      const content = fs.readFileSync(homeNpmrc, 'utf8')
      const match = content.match(/^registry\s*=\s*(.+)$/m)
      if (match?.[1]) {
        let reg = match[1].trim()
        if (reg.endsWith('/')) reg = reg.slice(0, -1)
        return reg
      }
    }
  } catch {}
  return undefined
}

/**
 * Install the VEH runtime interceptor:
 * 1. Synchronizes process.env (VEH_* -> DSH_*, VEH_HOME -> DSH_HOME).
 * 2. Migrates ~/.dsh to ~/.veh if ~/.veh does not exist.
 * 3. Intercepts filesystem calls to ~/.dsh, transparently redirecting to ~/.veh.
 * @param options - Interceptor configuration.
 * @returns Disposer function that uninstalls the interceptor and restores original methods.
 */
export function installVehInterceptor(options?: VehInterceptorOptions): () => void {
  if (installed && uninstallFn) return uninstallFn

  const defaultDshHome = join(homedir(), '.dsh')
  const vehHome = options?.vehHome ?? getVehHome()
  const userRegistry = detectUserNpmRegistry(process.env)

  // 1. Migrate if needed
  if (!options?.skipMigration) {
    migrateDshToVeh(defaultDshHome, vehHome)
  }

  // 2. Environment synchronization & dynamic Proxy
  process.env.VEH_HOME = vehHome
  process.env.DSH_HOME = vehHome
  if (userRegistry !== undefined) {
    process.env.DSH_DESKTOP_NPM_REGISTRY = userRegistry
    process.env.VEH_DESKTOP_NPM_REGISTRY = userRegistry
    process.env.npm_config_registry = userRegistry
    if (userRegistry.includes('npmmirror') && !process.env.ELECTRON_MIRROR) {
      process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    }
  }

  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('VEH_') && val !== undefined) {
      const dshKey = `DSH_${key.slice(4)}`
      process.env[dshKey] = val
    }
  }

  const originalEnv = process.env
  process.env = new Proxy(originalEnv, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return (target as Record<string | symbol, string | undefined>)[prop]
      if (prop === 'DSH_HOME') {
        return target.VEH_HOME ?? vehHome
      }
      if (prop === 'DSH_DESKTOP_NPM_REGISTRY' || prop === 'VEH_DESKTOP_NPM_REGISTRY') {
        return target.DSH_DESKTOP_NPM_REGISTRY ?? target.VEH_DESKTOP_NPM_REGISTRY ?? userRegistry
      }
      if (prop === 'ELECTRON_MIRROR' && userRegistry?.includes('npmmirror')) {
        return target.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/'
      }
      if (prop.startsWith('DSH_')) {
        const vehKey = `VEH_${prop.slice(4)}`
        if (vehKey in target && target[vehKey] !== undefined) return target[vehKey]
      }
      return Reflect.get(target, prop, receiver)
    },
    set(target, prop, value) {
      if (typeof prop === 'string') {
        if (prop.startsWith('DSH_')) {
          target[`VEH_${prop.slice(4)}`] = String(value)
        } else if (prop.startsWith('VEH_')) {
          target[`DSH_${prop.slice(4)}`] = String(value)
        }
        target[prop] = String(value)
        return true
      }
      return Reflect.set(target, prop, value)
    },
    defineProperty(target, prop, descriptor) {
      const normalizedDescriptor: PropertyDescriptor = {
        value: descriptor.value !== undefined ? String(descriptor.value) : (target as Record<string, string | undefined>)[String(prop)],
        writable: true,
        enumerable: true,
        configurable: true,
      }
      if (typeof prop === 'string' && normalizedDescriptor.value !== undefined) {
        const strVal = String(normalizedDescriptor.value)
        if (prop.startsWith('DSH_')) {
          target[`VEH_${prop.slice(4)}`] = strVal
        } else if (prop.startsWith('VEH_')) {
          target[`DSH_${prop.slice(4)}`] = strVal
        }
      }
      return Reflect.defineProperty(target, prop, normalizedDescriptor)
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'string') {
        if (prop.startsWith('DSH_')) delete target[`VEH_${prop.slice(4)}`]
        if (prop.startsWith('VEH_')) delete target[`DSH_${prop.slice(4)}`]
      }
      return Reflect.deleteProperty(target, prop)
    },
    has(target, prop) {
      if (prop === 'DSH_DESKTOP_NPM_REGISTRY' || prop === 'VEH_DESKTOP_NPM_REGISTRY') {
        if (userRegistry !== undefined) return true
      }
      if (typeof prop === 'string' && prop.startsWith('DSH_')) {
        if (`VEH_${prop.slice(4)}` in target) return true
      }
      return Reflect.has(target, prop)
    },
    ownKeys(target) {
      const keys = new Set(Reflect.ownKeys(target))
      keys.add('DSH_HOME')
      if (userRegistry !== undefined) {
        keys.add('DSH_DESKTOP_NPM_REGISTRY')
        keys.add('VEH_DESKTOP_NPM_REGISTRY')
      }
      for (const k of keys) {
        if (typeof k === 'string' && k.startsWith('VEH_')) {
          keys.add(`DSH_${k.slice(4)}`)
        }
      }
      return Array.from(keys)
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string') {
        if (prop === 'DSH_HOME') {
          return { value: target.VEH_HOME ?? vehHome, writable: true, enumerable: true, configurable: true }
        }
        if (prop === 'DSH_DESKTOP_NPM_REGISTRY' || prop === 'VEH_DESKTOP_NPM_REGISTRY') {
          const val = target.DSH_DESKTOP_NPM_REGISTRY ?? target.VEH_DESKTOP_NPM_REGISTRY ?? userRegistry
          if (val !== undefined) return { value: val, writable: true, enumerable: true, configurable: true }
        }
        if (prop.startsWith('DSH_')) {
          const vehKey = `VEH_${prop.slice(4)}`
          if (vehKey in target && target[vehKey] !== undefined) {
            return { value: target[vehKey], writable: true, enumerable: true, configurable: true }
          }
        }
      }
      return Reflect.getOwnPropertyDescriptor(target, prop)
    },
  })

  // 3. Path and content redirection helper
  function redirectPath<T>(target: T): T {
    if (typeof target !== 'string') return target
    const normalized = resolve(target)
    if (normalized === defaultDshHome) {
      return vehHome as unknown as T
    }
    if (normalized.startsWith(defaultDshHome + sep)) {
      return join(vehHome, normalized.slice(defaultDshHome.length + 1)) as unknown as T
    }
    return target
  }

  function filterEnvContent(filePath: unknown, content: unknown): unknown {
    if (typeof filePath !== 'string' || !filePath.includes('.env')) return content
    const isBuffer = Buffer.isBuffer(content)
    const text = isBuffer ? content.toString('utf8') : (typeof content === 'string' ? content : undefined)
    if (!text) return content

    const hasRegistry = text.includes('DSH_DESKTOP_NPM_REGISTRY') || text.includes('VEH_DESKTOP_NPM_REGISTRY')
    let filtered = text.split(/\r?\n/).map((line) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('VEH_BUILD=')) {
        process.env.VEH_BUILD = trimmed.slice(10).replace(/['"]/g, '').trim()
        return `# ${line}`
      }
      if (trimmed.startsWith('VEH_')) {
        return line.replace(/^(\s*)VEH_/, '$1DSH_')
      }
      return line
    }).join('\n')

    if (!hasRegistry && userRegistry !== undefined && typeof filePath === 'string' && (filePath.endsWith('.env.macos') || filePath.endsWith('.env.windows'))) {
      filtered += `\nDSH_DESKTOP_NPM_REGISTRY=${userRegistry}\n`
    }

    return isBuffer ? Buffer.from(filtered, 'utf8') : filtered
  }

  // 4. Wrap fs methods
  const originalFs: Record<string, unknown> = {}
  const singlePathMethods = [
    'readFile', 'readFileSync',
    'writeFile', 'writeFileSync',
    'appendFile', 'appendFileSync',
    'stat', 'statSync',
    'lstat', 'lstatSync',
    'access', 'accessSync',
    'mkdir', 'mkdirSync',
    'readdir', 'readdirSync',
    'unlink', 'unlinkSync',
    'rm', 'rmSync',
    'rmdir', 'rmdirSync',
    'realpath', 'realpathSync',
    'opendir', 'opendirSync',
    'open', 'openSync',
    'watch', 'watchFile', 'unwatchFile',
    'createReadStream', 'createWriteStream',
    'existsSync',
  ] as const

  function wrapSinglePath(target: Record<string, unknown>, backup: Record<string, unknown>, method: string): void {
    const orig = target[method]
    if (typeof orig !== 'function') return
    backup[method] = orig
    let wrapper: ((...args: unknown[]) => unknown) & { native?: (...args: unknown[]) => unknown }
    if (method === 'readFileSync') {
      wrapper = function (this: unknown, pathArg: unknown, ...rest: unknown[]) {
        const redirected = redirectPath(pathArg)
        const res = (orig as (...args: unknown[]) => unknown).call(this, redirected, ...rest)
        return filterEnvContent(redirected, res)
      }
    } else if (method === 'writeFileSync') {
      wrapper = function (this: unknown, pathArg: unknown, data: unknown, ...rest: unknown[]) {
        let finalData = data
        if (typeof pathArg === 'string' && pathArg.endsWith('npmrc') && userRegistry !== undefined) {
          const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : ''
          if (!text.includes('registry=')) {
            finalData = text ? `${text}\nregistry=${userRegistry}\n` : `registry=${userRegistry}\n`
          }
        }
        return (orig as (...args: unknown[]) => unknown).call(this, redirectPath(pathArg), finalData, ...rest)
      }
    } else if (target === fs && method === 'readFile') {
      wrapper = function (this: unknown, pathArg: unknown, ...rest: unknown[]) {
        const redirected = redirectPath(pathArg)
        const lastIdx = rest.length - 1
        if (typeof rest[lastIdx] === 'function') {
          const origCb = rest[lastIdx] as (err: unknown, data: unknown) => void
          rest[lastIdx] = function (err: unknown, data: unknown) {
            if (err) {
              origCb(err, data)
              return
            }
            origCb(null, filterEnvContent(redirected, data))
          }
        }
        return (orig as (...args: unknown[]) => unknown).call(this, redirected, ...rest)
      }
    } else if (target === fsp && method === 'readFile') {
      wrapper = async function (this: unknown, pathArg: unknown, ...rest: unknown[]) {
        const redirected = redirectPath(pathArg)
        const res = await (orig as (...args: unknown[]) => Promise<unknown>).call(this, redirected, ...rest)
        return filterEnvContent(redirected, res)
      }
    } else {
      wrapper = function (this: unknown, pathArg: unknown, ...rest: unknown[]) {
        return (orig as (...args: unknown[]) => unknown).call(this, redirectPath(pathArg), ...rest)
      }
    }
    const origWithNative = orig as ((...args: unknown[]) => unknown) & { native?: (...args: unknown[]) => unknown }
    if (typeof origWithNative.native === 'function') {
      const origNative = origWithNative.native
      wrapper.native = function (this: unknown, pathArg: unknown, ...rest: unknown[]) {
        return origNative.call(this, redirectPath(pathArg), ...rest)
      }
    }
    target[method] = wrapper
  }

  function wrapTwoPaths(target: Record<string, unknown>, backup: Record<string, unknown>, method: string): void {
    const orig = target[method]
    if (typeof orig !== 'function') return
    backup[method] = orig
    target[method] = function (this: unknown, src: unknown, dest: unknown, ...rest: unknown[]) {
      return (orig as (...args: unknown[]) => unknown).call(this, redirectPath(src), redirectPath(dest), ...rest)
    }
  }

  for (const method of singlePathMethods) wrapSinglePath(fs, originalFs, method)

  const twoPathMethods = ['copyFile', 'copyFileSync', 'rename', 'renameSync', 'cp', 'cpSync'] as const
  for (const method of twoPathMethods) wrapTwoPaths(fs, originalFs, method)

  // 5. Wrap fs/promises methods
  const originalFsp: Record<string, unknown> = {}
  const fspSinglePathMethods = [
    'readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'access',
    'mkdir', 'readdir', 'unlink', 'rm', 'rmdir', 'realpath', 'opendir', 'open', 'watch',
  ] as const
  for (const method of fspSinglePathMethods) wrapSinglePath(fsp, originalFsp, method)

  const fspTwoPathMethods = ['copyFile', 'rename', 'cp'] as const
  for (const method of fspTwoPathMethods) wrapTwoPaths(fsp, originalFsp, method)

  installed = true

  const uninstall = (): void => {
    process.env = originalEnv
    for (const [method, orig] of Object.entries(originalFs)) {
      ;(fs as Record<string, unknown>)[method] = orig
    }
    for (const [method, orig] of Object.entries(originalFsp)) {
      ;(fsp as Record<string, unknown>)[method] = orig
    }
    installed = false
    uninstallFn = undefined
  }

  uninstallFn = uninstall
  return uninstall
}
