import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectUserNpmRegistry,
  getVehHome,
  installVehInterceptor,
  isVehInterceptorInstalled,
  migrateDshToVeh,
} from '../src/interceptor.ts'

describe('VEH runtime interceptor', () => {
  const originalEnv = { ...process.env }
  let cleanupDir: string | undefined

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    if (cleanupDir && fs.existsSync(cleanupDir)) {
      fs.rmSync(cleanupDir, { recursive: true, force: true })
      cleanupDir = undefined
    }
  })

  describe('getVehHome', () => {
    it('returns default ~/.veh when VEH_HOME is unset', () => {
      delete process.env.VEH_HOME
      expect(getVehHome({})).toBe(join(homedir(), '.veh'))
    })

    it('expands tilde and resolves VEH_HOME override', () => {
      expect(getVehHome({ VEH_HOME: '~/custom-veh' })).toBe(join(homedir(), 'custom-veh'))
      expect(getVehHome({ VEH_HOME: '~' })).toBe(homedir())
      expect(getVehHome({ VEH_HOME: '/explicit/veh/dir' })).toBe(resolve('/explicit/veh/dir'))
    })

    it('strictly isolates and ignores DSH_HOME', () => {
      expect(getVehHome({ DSH_HOME: '/legacy/dsh' })).toBe(join(homedir(), '.veh'))
    })
  })

  describe('detectUserNpmRegistry', () => {
    it('detects registry from environment variables', () => {
      expect(detectUserNpmRegistry({ npm_config_registry: 'https://registry.npmmirror.com/' })).toBe('https://registry.npmmirror.com')
      expect(detectUserNpmRegistry({ VEH_DESKTOP_NPM_REGISTRY: 'https://custom.registry.com' })).toBe('https://custom.registry.com')
    })
  })

  describe('migrateDshToVeh', () => {
    it('copies files recursively when veh does not exist and dsh exists', () => {
      cleanupDir = join(tmpdir(), `veh-migration-test-${Date.now()}`)
      const dshDir = join(cleanupDir, '.dsh')
      const vehDir = join(cleanupDir, '.veh')

      fs.mkdirSync(join(dshDir, 'sub'), { recursive: true })
      fs.writeFileSync(join(dshDir, 'sub', 'file.txt'), 'migrated-content')

      migrateDshToVeh(dshDir, vehDir)

      expect(fs.existsSync(join(vehDir, 'sub', 'file.txt'))).toBe(true)
      expect(fs.readFileSync(join(vehDir, 'sub', 'file.txt'), 'utf8')).toBe('migrated-content')
    })

    it('does not overwrite or copy if veh directory already exists', () => {
      cleanupDir = join(tmpdir(), `veh-exist-test-${Date.now()}`)
      const dshDir = join(cleanupDir, '.dsh')
      const vehDir = join(cleanupDir, '.veh')

      fs.mkdirSync(dshDir, { recursive: true })
      fs.mkdirSync(vehDir, { recursive: true })
      fs.writeFileSync(join(dshDir, 'file.txt'), 'from-dsh')
      fs.writeFileSync(join(vehDir, 'file.txt'), 'from-veh')

      migrateDshToVeh(dshDir, vehDir)

      expect(fs.readFileSync(join(vehDir, 'file.txt'), 'utf8')).toBe('from-veh')
    })
  })

  describe('installVehInterceptor', () => {
    it('synchronizes environment, redirects filesystem calls, and uninstalls cleanly', async () => {
      cleanupDir = join(tmpdir(), `veh-install-test-${Date.now()}`)
      const testVehHome = join(cleanupDir, '.veh')
      const fakeDshDir = join(homedir(), '.dsh')
      fs.mkdirSync(testVehHome, { recursive: true })

      process.env.VEH_CUSTOM_VAR = 'custom_value'

      const uninstall = installVehInterceptor({
        vehHome: testVehHome,
        skipMigration: true,
      })

      try {
        expect(isVehInterceptorInstalled()).toBe(true)
        expect(process.env.VEH_HOME).toBe(testVehHome)
        expect(process.env.DSH_HOME).toBe(testVehHome)
        expect(process.env.DSH_CUSTOM_VAR).toBe('custom_value')

        // Test sync fs redirection
        const testFileDsh = join(fakeDshDir, 'test-sync.txt')
        const testFileVeh = join(testVehHome, 'test-sync.txt')

        fs.writeFileSync(testFileDsh, 'hello-sync')
        expect(fs.existsSync(testFileDsh)).toBe(true)
        expect(fs.existsSync(testFileVeh)).toBe(true)
        expect(fs.readFileSync(testFileDsh, 'utf8')).toBe('hello-sync')

        // Test async/promises fs redirection
        const testFileDshAsync = join(fakeDshDir, 'test-async.txt')
        const testFileVehAsync = join(testVehHome, 'test-async.txt')

        await fsp.writeFile(testFileDshAsync, 'hello-async')
        expect(fs.existsSync(testFileVehAsync)).toBe(true)
        expect(await fsp.readFile(testFileDshAsync, 'utf8')).toBe('hello-async')

        // Paths outside ~/.dsh are unaffected
        const regularFile = join(cleanupDir, 'normal.txt')
        fs.writeFileSync(regularFile, 'normal')
        expect(fs.readFileSync(regularFile, 'utf8')).toBe('normal')

        // Test dynamic environment proxy
        process.env.VEH_DYNAMIC_VAR = 'dynamic_value'
        expect(process.env.DSH_DYNAMIC_VAR).toBe('dynamic_value')
        expect('DSH_DYNAMIC_VAR' in process.env).toBe(true)

        process.env.DSH_OUT_VAR = 'out_value'
        expect(process.env.VEH_OUT_VAR).toBe('out_value')

        // Test .env file filtering
        const envFile = join(cleanupDir, '.env.windows')
        fs.writeFileSync(envFile, 'VEH_BUILD=1\nVEH_DESKTOP_APP_ID=com.voiceedge.harness\n')
        const readEnv = fs.readFileSync(envFile, 'utf8')
        expect(readEnv).toContain('# VEH_BUILD=1')
        expect(readEnv).toContain('DSH_DESKTOP_APP_ID=com.voiceedge.harness')
        expect(process.env.VEH_BUILD).toBe('1')

        const readEnvAsync = await fsp.readFile(envFile, 'utf8')
        expect(readEnvAsync).toContain('# VEH_BUILD=1')
        expect(readEnvAsync).toContain('DSH_DESKTOP_APP_ID=com.voiceedge.harness')
        if (process.env.DSH_DESKTOP_NPM_REGISTRY) {
          expect(readEnvAsync).toContain('DSH_DESKTOP_NPM_REGISTRY=')
        }

        // Test npmrc writing
        const npmrcFile = join(cleanupDir, 'config', 'npmrc')
        fs.mkdirSync(join(cleanupDir, 'config'), { recursive: true })
        fs.writeFileSync(npmrcFile, '')
        const readNpmrc = fs.readFileSync(npmrcFile, 'utf8')
        if (process.env.DSH_DESKTOP_NPM_REGISTRY) {
          expect(readNpmrc).toContain(`registry=${process.env.DSH_DESKTOP_NPM_REGISTRY}`)
        }

        // Test fs.realpath.native preservation
        expect(typeof fs.realpath.native).toBe('function')
        expect(typeof fs.realpathSync.native).toBe('function')
      } finally {
        uninstall()
      }

      expect(isVehInterceptorInstalled()).toBe(false)
    })
  })
})
