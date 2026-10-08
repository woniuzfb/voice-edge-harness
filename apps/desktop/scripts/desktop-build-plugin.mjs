/** Desktop build plugin interface and loader. */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vehBuildPlugin } from './plugins/veh-build-plugin.mjs'
import '../src/veh-interceptor.ts'

/**
 * @typedef {Object} DesktopBuildPlugin
 * @property {string} name - Plugin name.
 * @property {string} [productName] - Custom product name (e.g. 'VoiceEdge Harness').
 * @property {string} [appId] - Custom reverse-DNS application identifier.
 * @property {string} [artifactName] - Custom artifactName pattern.
 * @property {string} [runtimeDirName] - Runtime directory name inside ASAR and unpacked folder (defaults to 'dsh').
 * @property {Array<{ name: string, schemes: string[] }>} [protocols] - Custom protocols.
 * @property {(config: any, env: NodeJS.ProcessEnv) => void | Promise<void>} [modifyConfig] - Config hook.
 * @property {(context: any) => void | Promise<void>} [beforePack]
 * @property {(context: any) => void | Promise<void>} [afterPack]
 * @property {(context: any) => void | Promise<void>} [afterSign]
 */

/** @type {Record<string, DesktopBuildPlugin>} */
const BUILTIN_PLUGINS = {
  veh: vehBuildPlugin,
  'veh-build-plugin': vehBuildPlugin,
}

/**
 * Resolve the active desktop packaging plugin from environment or default location.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {DesktopBuildPlugin | undefined} Loaded build plugin, or undefined for default build.
 */
export function resolveDesktopBuildPlugin(env = process.env) {
  // If app ID is explicitly specified and does not mention voiceedge, do not activate veh plugin
  if (env.DSH_DESKTOP_APP_ID !== undefined && !env.DSH_DESKTOP_APP_ID.includes('voiceedge')) {
    return undefined
  }
  let plugin
  const pluginSpecifier = env.VEH_BUILD_PLUGIN || env.DSH_DESKTOP_BUILD_PLUGIN
  if (pluginSpecifier && BUILTIN_PLUGINS[pluginSpecifier]) {
    plugin = BUILTIN_PLUGINS[pluginSpecifier]
  } else if (
    env.VEH_BUILD === '1' ||
    env.VEH_DESKTOP_APP_ID !== undefined ||
    (typeof env.DSH_DESKTOP_APP_ID === 'string' && env.DSH_DESKTOP_APP_ID.includes('voiceedge'))
  ) {
    plugin = vehBuildPlugin
  } else if (process.env.VITEST !== 'true') {
    try {
      const desktopDir = resolve(import.meta.dirname, '..')
      for (const file of ['.env.macos', '.env.windows']) {
        const p = join(desktopDir, file)
        if (existsSync(p)) {
          const text = readFileSync(p, 'utf8')
          if (text.includes('voiceedge') || text.includes('VEH_')) {
            plugin = vehBuildPlugin
            break
          }
        }
      }
    } catch {}
  }
  if (plugin && process.env.DSH_DESKTOP_NPM_REGISTRY) {
    env.DSH_DESKTOP_NPM_REGISTRY ??= process.env.DSH_DESKTOP_NPM_REGISTRY
    env.npm_config_registry ??= process.env.DSH_DESKTOP_NPM_REGISTRY
  }
  return plugin
}
