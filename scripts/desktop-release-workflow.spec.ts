import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflow = yaml.load(
  readFileSync(resolve(root, '.github/workflows/desktop-release.yml'), 'utf8'),
) as {
  name: string
  on: Record<string, unknown>
  permissions: Record<string, string>
  jobs: Record<string, {
    name: string
    'runs-on'?: string
    strategy?: { matrix: { include: Array<{ target: string; os: string }> } }
    steps?: Array<{ name?: string; uses?: string; run?: string }>
  }>
}

describe('Desktop release workflow', () => {
  it('defines workflow triggers for manual dispatch and release tags', () => {
    expect(workflow.name).toBe('Desktop Release')
    expect(workflow.on).toHaveProperty('workflow_dispatch')
    expect(workflow.on).toHaveProperty('push')
    expect(workflow.permissions).toMatchObject({ contents: 'write' })
  })

  it('configures windows and mac packaging matrix jobs', () => {
    expect(workflow.jobs).toHaveProperty('build-windows')
    expect(workflow.jobs).toHaveProperty('build-mac')
    expect(workflow.jobs).toHaveProperty('publish-release')

    const winJob = workflow.jobs['build-windows']!
    expect(winJob['runs-on']).toBe('windows-latest')
    const winSteps = winJob.steps?.map(s => s.name ?? s.run ?? '') ?? []
    expect(winSteps.some(s => s.includes('Package Windows Installer'))).toBe(true)

    const macJob = workflow.jobs['build-mac']!
    expect(macJob['runs-on']).toBe('macos-latest')
    const macSteps = macJob.steps?.map(s => s.name ?? s.run ?? '') ?? []
    expect(macSteps.some(s => s.includes('Package macOS Desktop App'))).toBe(true)
  })

  it('configures release publication with artifact collection', () => {
    const releaseJob = workflow.jobs['publish-release']!
    expect(releaseJob['runs-on']).toBe('ubuntu-24.04')
    const releaseSteps = releaseJob.steps?.map(s => s.name ?? '') ?? []
    expect(releaseSteps).toContain('Publish to GitHub Release')
  })
})
