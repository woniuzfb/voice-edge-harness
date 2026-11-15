import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  installBrandFetchRewrite,
  rewriteBrandText,
  rewriteChatRequestBody,
  rewriteGenerateOptions,
} from '../src/brand.ts'

describe('outbound prompt brand rewrite', () => {
  it('rewrites exact prompt brand phrases while leaving bare dsh/DSH tokens, paths, repo names, and identifiers untouched', () => {
    expect(rewriteBrandText('You are an AI agent powered by DeepSeek Harness.').text)
      .toBe('You are an AI agent powered by VoiceEdge Harness.')
    expect(rewriteBrandText('powered by deepseek harness').text)
      .toBe('powered by voiceedge harness')
    expect(rewriteBrandText('facts about DeepSeek Harness (DSH) itself').text)
      .toBe('facts about VoiceEdge Harness (VEH) itself')
    expect(rewriteBrandText('Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode.').text)
      .toBe('Current VEH file policy: read-only. Any available operation enforced by the VEH file sandbox cannot modify files in the standing mode.')
    expect(rewriteBrandText('Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.').text)
      .toBe('Current VEH file policy: danger-full-access. The VEH file sandbox does not restrict file modifications by available operations.')
    expect(rewriteBrandText('Use this checkout only to inspect or extend DSH itself.').text)
      .toBe('Use this checkout only to inspect or extend VEH itself.')
    expect(rewriteBrandText('Unmet DSH version requirements (engines.dsh, else DSH peer dependencies) block installation and activation.').text)
      .toBe('Unmet VEH version requirements (engines.dsh, else VEH peer dependencies) block installation and activation.')

    // Bare dsh/DSH in user prose, CLI commands, paths, repo names, env vars, and manifest keys stay untouched.
    for (const preserved of [
      'The deepseek-harness checkout is here',
      '/Users/x/Documents/github/deepseek-harness',
      '/Users/x/Documents/github/voiceedge-harness',
      '--Users-x-Documents-github-deepseek-harness--',
      'read ~/.dsh/AGENTS.md',
      '.dsh/skills',
      'apps/desktop/dsh',
      'dsh/config.json',
      'run dsh plugin install',
      'only dsh web injects window.__DSH_BOOT__',
      'why did dsh stop?',
      'check DSH status',
      'DSH_HOME',
      'declares no dsh.bundle',
      'dsh-badge',
      '@deepseek-ai/dsh-llm',
      'WSServerHandshakeError during handshake',
    ]) {
      expect(rewriteBrandText(preserved)).toEqual({
        text: preserved,
        changed: false,
      })
    }
  })

  it('reports whether anything changed', () => {
    expect(rewriteBrandText('nothing to see')).toEqual({ text: 'nothing to see', changed: false })
    expect(rewriteBrandText('You are an AI agent powered by DeepSeek Harness.').changed).toBe(true)
  })

  it('rewrites exact brand phrases in prompt messages and tool declarations while leaving tool results and assistant messages untouched', () => {
    const toolMsg = {
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: 'Error in ~/.dsh/x and WSServerHandshakeError from DeepSeek Harness' }],
    }
    const assistantMsg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'DeepSeek Harness output with dsh-spill path' }],
    }
    const options = {
      provider: 'voice-edge',
      model: 'gemini:app/test',
      system: 'Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Current DeepSeek Harness implementation checkout: "/Users/x/Documents/github/deepseek-harness".' }] },
        assistantMsg,
        toolMsg,
      ],
      tools: [
        {
          name: 'plugin_manager',
          description: 'Unmet DSH version requirements (engines.dsh, else DSH peer dependencies) block installation.',
          parameters: {
            type: 'object',
            properties: {
              runtimeVersion: {
                type: 'string',
                description: 'For set_version_exemption: exact DSH version from list_version_exemptions.',
              },
            },
          },
        },
      ],
    } as unknown as GenerateOptions

    expect(rewriteGenerateOptions(options)).toBe(true)
    expect(options.system).toBe('Current VEH file policy: workspace-write. Any available operation enforced by the VEH file sandbox may modify files.')
    expect(JSON.stringify(options.messages[0])).toContain('Current VoiceEdge Harness implementation checkout: \\"/Users/x/Documents/github/deepseek-harness\\".')
    // Tool results and assistant messages are never rewritten.
    expect(options.messages[1]).toBe(assistantMsg)
    expect(options.messages[2]).toBe(toolMsg)
    expect(options.tools?.[0]?.description).toBe('Unmet VEH version requirements (engines.dsh, else VEH peer dependencies) block installation.')
    expect(JSON.stringify(options.tools)).toContain('For set_version_exemption: exact VEH version from list_version_exemptions.')
    // Route selection stays untouched.
    expect(options.provider).toBe('voice-edge')
    expect(options.model).toBe('gemini:app/test')
  })

  it('leaves the original messages array intact', () => {
    const original = [{ role: 'user', content: [{ type: 'text', text: 'powered by DeepSeek Harness' }] }]
    const options = { provider: 'p', model: 'm', messages: original } as unknown as GenerateOptions
    rewriteGenerateOptions(options)
    expect(original[0]?.content[0]).toEqual({ type: 'text', text: 'powered by DeepSeek Harness' })
    expect(options.messages).not.toBe(original)
  })
})

describe('frozen request and wire-level rewrite', () => {
  it('leaves a frozen GenerateOptions untouched instead of throwing', () => {
    const options = Object.freeze({
      provider: 'voice-edge',
      model: 'gemini-4-carbon',
      system: 'You are an AI agent powered by DeepSeek Harness.',
      messages: Object.freeze([]),
    }) as unknown as GenerateOptions
    expect(Object.isFrozen(options)).toBe(true)
    expect(() => rewriteGenerateOptions(options)).not.toThrow()
    expect(rewriteGenerateOptions(options)).toBe(false)
    expect(options.system).toBe('You are an AI agent powered by DeepSeek Harness.')
  })

  it('rewrites exact prompt brand fields of a loopback chat body while leaving user dsh/DSH tokens, paths, repo names, tool results, and assistant messages intact', () => {
    const body = JSON.stringify({
      model: 'gemini:app/gemini-4-carbon-high',
      messages: [
        {
          role: 'system',
          content: 'You are an AI agent powered by DeepSeek Harness.\nCurrent DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications.\nCurrent working directory: "/Users/x/Documents/github/deepseek-harness"',
        },
        { role: 'user', content: 'read ~/.dsh/AGENTS.md in deepseek-harness and check dsh / DSH status' },
        { role: 'assistant', content: 'Checking dsh_config and WSServerHandshakeError.' },
        { role: 'tool', tool_call_id: 'call_1', content: '/var/folders/x/dsh-spill-1/out.txt: DeepSeek Harness' },
      ],
      tools: [{ type: 'function', function: { name: 'plugin_manager', description: 'Unmet DSH version requirements (engines.dsh, else DSH peer dependencies).' } }],
    })
    const rewritten = rewriteChatRequestBody('http://127.0.0.1:5002/v1/chat/completions', body)
    expect(rewritten).not.toBe(body)
    const payload = JSON.parse(rewritten) as {
      messages: Array<{ role: string; content: string }>
      tools: Array<{ function: { description: string } }>
    }
    expect(payload.messages[0]?.content).toContain('VoiceEdge Harness')
    expect(payload.messages[0]?.content).toContain('Current VEH file policy: danger-full-access. The VEH file sandbox')
    expect(payload.messages[0]?.content).toContain('"/Users/x/Documents/github/deepseek-harness"')
    expect(payload.messages[1]?.content).toBe('read ~/.dsh/AGENTS.md in deepseek-harness and check dsh / DSH status')
    // Assistant and tool messages must remain byte-for-byte untouched.
    expect(payload.messages[2]?.content).toBe('Checking dsh_config and WSServerHandshakeError.')
    expect(payload.messages[3]?.content).toBe('/var/folders/x/dsh-spill-1/out.txt: DeepSeek Harness')
    expect(payload.tools[0]?.function.description).toBe('Unmet VEH version requirements (engines.dsh, else VEH peer dependencies).')

    // A tool-only continuation where prompts have no old-brand tokens returns the original body string.
    const toolOnlyBody = JSON.stringify({
      model: 'gemini:app/gemini-4-carbon-high',
      messages: [
        { role: 'user', content: 'inspect file in deepseek-harness with dsh and DSH' },
        { role: 'tool', tool_call_id: 'call_1', content: 'DeepSeek Harness DSH dsh' },
      ],
    })
    expect(rewriteChatRequestBody('http://127.0.0.1:5002/v1/chat/completions', toolOnlyBody)).toBe(toolOnlyBody)

    // Non-loopback traffic and bodies without the brand pass through unchanged.
    expect(rewriteChatRequestBody('https://example.com/v1/chat/completions', body)).toBe(body)
    expect(rewriteChatRequestBody('http://127.0.0.1:5002/v1/chat/completions', '{"a":1}')).toBe('{"a":1}')
    expect(rewriteChatRequestBody('http://127.0.0.1:5002/v1/chat/completions', 'not json')).toBe('not json')
  })

  it('patches fetch and restores the original on dispose', async () => {
    const originalFetch = globalThis.fetch
    let seen: RequestInit | undefined
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init
      return new Response('{}', { status: 200 })
    }
    const dispose = installBrandFetchRewrite()
    try {
      const body = JSON.stringify({
        messages: [{ role: 'system', content: 'powered by DeepSeek Harness' }],
      })
      await globalThis.fetch('http://127.0.0.1:5002/v1/chat/completions', { method: 'POST', body })
      expect(seen?.body as string).toContain('VoiceEdge Harness')
      // Other hosts are never rewritten.
      await globalThis.fetch('https://example.com/v1/chat/completions', { method: 'POST', body })
      expect(seen?.body).toBe(body)
    } finally {
      dispose()
      globalThis.fetch = originalFetch
    }
  })
})
