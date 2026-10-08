import { describe, expect, it } from 'vitest'
import { parseTagArgs } from './release-tag.ts'

describe('parseTagArgs', () => {
  it('parses positional tag argument', () => {
    expect(parseTagArgs(['v0.2.0'])).toEqual({
      tag: 'v0.2.0',
      allowDirty: false,
      dryRun: false,
      clean: false,
      deleteOnly: false,
    })
  })

  it('parses --tag=value argument', () => {
    expect(parseTagArgs(['--tag=v0.2.0-rc.2'])).toEqual({
      tag: 'v0.2.0-rc.2',
      allowDirty: false,
      dryRun: false,
      clean: false,
      deleteOnly: false,
    })
  })

  it('parses --tag value argument', () => {
    expect(parseTagArgs(['--tag', 'desktop-v1.0.0'])).toEqual({
      tag: 'desktop-v1.0.0',
      allowDirty: false,
      dryRun: false,
      clean: false,
      deleteOnly: false,
    })
  })

  it('parses -t value argument', () => {
    expect(parseTagArgs(['-t', 'v1.0.0'])).toEqual({
      tag: 'v1.0.0',
      allowDirty: false,
      dryRun: false,
      clean: false,
      deleteOnly: false,
    })
  })

  it('parses boolean flags', () => {
    expect(parseTagArgs(['--tag=v1.0.0', '--allow-dirty', '--dry-run', '--clean'])).toEqual({
      tag: 'v1.0.0',
      allowDirty: true,
      dryRun: true,
      clean: true,
      deleteOnly: false,
    })
  })

  it('parses delete flag', () => {
    expect(parseTagArgs(['v1.0.0', '--delete'])).toEqual({
      tag: 'v1.0.0',
      allowDirty: false,
      dryRun: false,
      clean: false,
      deleteOnly: true,
    })

    expect(parseTagArgs(['v1.0.0', '-d'])).toEqual({
      tag: 'v1.0.0',
      allowDirty: false,
      dryRun: false,
      clean: false,
      deleteOnly: true,
    })
  })

  it('parses clean flag aliases', () => {
    expect(parseTagArgs(['v1.0.0', '--force']).clean).toBe(true)
    expect(parseTagArgs(['v1.0.0', '-f']).clean).toBe(true)
    expect(parseTagArgs(['v1.0.0', '--recreate']).clean).toBe(true)
  })

  it('returns null tag when no arguments provided and env is empty', () => {
    const originalTag = process.env.TAG
    try {
      delete process.env.TAG
      expect(parseTagArgs([])).toEqual({
        tag: null,
        allowDirty: false,
        dryRun: false,
        clean: false,
        deleteOnly: false,
      })
    } finally {
      if (originalTag !== undefined) {
        process.env.TAG = originalTag
      }
    }
  })
})
