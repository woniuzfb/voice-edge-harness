import type { Configuration, BeforePackContext, AfterPackContext } from 'app-builder-lib'

export interface DesktopBuildPlugin {
  readonly name: string
  readonly productName?: string
  readonly appId?: string
  readonly artifactName?: string
  readonly runtimeDirName?: string
  readonly protocols?: readonly { readonly name: string; readonly schemes: readonly string[] }[]
  readonly modifyConfig?: (config: Configuration, env: NodeJS.ProcessEnv) => void | Promise<void>
  readonly beforePack?: (context: BeforePackContext) => void | Promise<void>
  readonly afterPack?: (context: AfterPackContext) => void | Promise<void>
  readonly afterSign?: (context: AfterPackContext) => void | Promise<void>
}

export function resolveDesktopBuildPlugin(env?: NodeJS.ProcessEnv): DesktopBuildPlugin | undefined
