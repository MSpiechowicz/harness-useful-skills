import type { PromptOrigin } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { fakeCli, fakeClock, fakeToasts, fakeUser, runCommand, STATUS_JSON } from './register-test-helpers'

describe('useful-skills command with arguments', () => {
  test('passes the arguments to the CLI in the session cwd and returns its output', async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'status text\n' }))

    const result = await runCommand($, '  stage   plan disabled ')

    expect(result.text).toBe('status text')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv.slice(0, 1)).toEqual(['node'])
    expect(calls[0]!.argv[1]).toMatch(/claude\/command\.js$/)
    expect(calls[0]!.argv.slice(2)).toEqual(['stage', 'plan', 'disabled'])
    expect(calls[0]!.timeoutMs).toBe(60000)
  })

  test('returns stderr when the CLI fails without stdout', async ($, on) => {
    fakeCli(on, () => ({ exitCode: 2, stderr: 'Unknown stage.\n' }))

    const result = await runCommand($, 'stage nope enabled')

    expect(result.text).toBe('Unknown stage.')
  })

  test('reports silence from the CLI as unconfirmed, even with exit 0', async ($, on) => {
    fakeCli(on, () => ({ exitCode: 0 }))

    const result = await runCommand($, 'stage plan disabled')

    expect(result.text).toBe('Useful Skills command produced no output; nothing was confirmed.')
  })

  test('reports a silent failing CLI by its exit code', async ($, on) => {
    fakeCli(on, () => ({ exitCode: 3 }))

    const result = await runCommand($, 'status')

    expect(result.text).toBe('Useful Skills command failed (exit 3).')
  })

  test('refuses more than eight tokens without running the CLI', async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'ran' }))

    const result = await runCommand($, 'list a b c d e f g h')

    expect(calls).toHaveLength(0)
    expect(result.text).toContain('Usage: /useful-skills')
  })

  test('runs exactly eight tokens', async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'ran' }))

    const result = await runCommand($, 'list a b c d e f g')

    expect(result.text).toBe('ran')
    expect(calls).toHaveLength(1)
  })

  test('answers with a fixed Node.js message when the CLI cannot start', async ($, on) => {
    fakeCli(on, () => 'unavailable')

    const result = await runCommand($, 'status')

    expect(result.text).toBe('Useful Skills needs Node.js 22+ on PATH to run /useful-skills.')
  })

  test('passes boolean plugin options to the CLI as CLAUDE_PLUGIN_OPTION_* variables', async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'ok' }))

    await runCommand($, 'status')

    expect(calls[0]!.env).toEqual({
      CLAUDE_PLUGIN_OPTION_WORKFLOW: 'true',
      CLAUDE_PLUGIN_OPTION_RESEARCH: 'true',
      CLAUDE_PLUGIN_OPTION_PLAN: 'true',
      CLAUDE_PLUGIN_OPTION_REVIEW: 'true',
      CLAUDE_PLUGIN_OPTION_SECURITY_REVIEW: 'true',
      CLAUDE_PLUGIN_OPTION_RELEASE_ASSESSMENT: 'true',
      CLAUDE_PLUGIN_OPTION_BACKEND_MEMORY: 'true',
      CLAUDE_PLUGIN_OPTION_GRAPHIFY_MEMORY: 'true',
    })
  })

  test('maps configured false options to "false"', { options: { workflow: false, security_review: false, release_assessment: false } }, async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'ok' }))

    await runCommand($, 'status')

    expect(calls[0]!.env).toMatchObject({
      CLAUDE_PLUGIN_OPTION_WORKFLOW: 'false',
      CLAUDE_PLUGIN_OPTION_SECURITY_REVIEW: 'false',
      CLAUDE_PLUGIN_OPTION_RELEASE_ASSESSMENT: 'false',
    })
  })

  test('passes an explicit code_graph next to a legacy graphify_memory', { options: { graphify_memory: false, code_graph: true } }, async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'ok' }))

    await runCommand($, 'status')

    expect(calls[0]!.env).toMatchObject({ CLAUDE_PLUGIN_OPTION_GRAPHIFY_MEMORY: 'false', CLAUDE_PLUGIN_OPTION_CODE_GRAPH: 'true' })
  })

  test('keeps an explicit code_graph=false next to a legacy value', { options: { graphify_memory: true, code_graph: false } }, async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'ok' }))

    await runCommand($, 'status')

    expect(calls[0]!.env).toMatchObject({ CLAUDE_PLUGIN_OPTION_CODE_GRAPH: 'false' })
  })
})

describe('useful-skills interactive menu', () => {
  test('walks Settings, Stages…, Stages 1/3, Plan, Disabled to the stage command', async ($, on) => {
    const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'Plan stage: disabled.' }))
    const asked = fakeUser(on, ['Settings', 'Stages…', 'Stages 1/3', 'Plan (disabled)', 'Disabled'])

    const result = await runCommand($, '')

    expect(result.text).toBe('Plan stage: disabled.')
    expect(calls.map(call => call.argv.slice(2))).toEqual([['status', '--json'], ['stage', 'plan', 'disabled']])
    expect(asked[0]!.options).toEqual(['Settings', 'Status', 'Browse', 'Help'])
    expect(asked[1]!.options).toEqual(['Repository workflow (enabled)', 'Stages…', 'Back'])
    expect(asked[2]!.options).toEqual(['Stages 1/3', 'Stages 2/3', 'Stages 3/3', 'Back'])
    expect(asked[3]!.options).toEqual(['Research (enabled)', 'Plan (disabled)', 'Review (unknown)', 'Back'])
    expect(asked[4]!.options).toEqual(['Enabled', 'Disabled', 'Back'])
  })

  test('walks Settings, Stages…, Stages 2/3, Release assessment, Enabled to the stage command', async ($, on) => {
    const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'Release assessment stage: enabled.' }))
    const asked = fakeUser(on, ['Settings', 'Stages…', 'Stages 2/3', 'Release assessment (unknown)', 'Enabled'])

    const result = await runCommand($, '')

    expect(result.text).toBe('Release assessment stage: enabled.')
    expect(calls.map(call => call.argv.slice(2))).toEqual([['status', '--json'], ['stage', 'release-assessment', 'enabled']])
    expect(asked[3]!.options).toEqual(['Security review (unknown)', 'Release assessment (unknown)', 'Back'])
    expect(asked[4]!.options).toEqual(['Enabled', 'Disabled', 'Back'])
  })

  test('Stages 3/3 lists Backend memory and Code graph', async ($, on) => {
    const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'Code graph stage: disabled.' }))
    const asked = fakeUser(on, ['Settings', 'Stages…', 'Stages 3/3', 'Code graph (unknown)', 'Disabled'])

    await runCommand($, '')

    expect(asked[3]!.options).toEqual(['Backend memory (unknown)', 'Code graph (unknown)', 'Back'])
    expect(calls.at(-1)!.argv.slice(2)).toEqual(['stage', 'code-graph', 'disabled'])
  })

  test('Back walks from a stage list through Stages… to Settings and the main menu', async ($, on) => {
    const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'help text' }))
    const asked = fakeUser(on, ['Settings', 'Stages…', 'Stages 2/3', 'Back', 'Back', 'Back', 'Help'])

    const result = await runCommand($, '')

    expect(result.text).toBe('help text')
    expect(asked.map(question => question.options[0])).toEqual([
      'Settings', 'Repository workflow (enabled)', 'Stages 1/3', 'Security review (unknown)',
      'Stages 1/3', 'Repository workflow (enabled)', 'Settings',
    ])
    expect(calls.at(-1)!.argv.slice(2)).toEqual(['help'])
  })

  test('Back returns to the parent menu', async ($, on) => {
    fakeClock(on)
    const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'doctor output' }))
    const asked = fakeUser(on, ['Browse', 'Back', 'Browse', 'Doctor…', 'Back', 'Doctor…', 'Set up memory'])

    const result = await runCommand($, '')

    expect(result.text).toBe('doctor output')
    expect(asked[0]!.options).toEqual(['Settings', 'Status', 'Browse', 'Help'])
    expect(asked[1]!.options).toEqual(['List', 'Doctor…', 'Back'])
    expect(asked[2]!.options).toEqual(['Settings', 'Status', 'Browse', 'Help'])
    expect(asked[4]!.options).toEqual(['Set up memory', 'Check only', 'Back'])
    expect(asked[5]!.options).toEqual(['List', 'Doctor…', 'Back'])
    expect(calls.at(-1)!.argv.slice(2)).toEqual(['doctor'])
  })

  test('labels fall back to unknown when status cannot be read', async ($, on) => {
    fakeCli(on, tokens => (tokens[0] === 'status' ? { exitCode: 1, stderr: 'boom' } : { stdout: 'ok' }))
    const asked = fakeUser(on, ['Settings', 'Back', 'Help'])

    await runCommand($, '')

    expect(asked[1]!.options[0]).toBe('Repository workflow (unknown)')
  })

  test('free text typed under Other is never executed', async ($, on) => {
    const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'executed' }))
    fakeUser(on, ['doctor; rm -rf /'])

    const result = await runCommand($, '')

    expect(result.text).toBe('No change.')
    expect(calls.map(call => call.argv.slice(2))).toEqual([['status', '--json']])
  })

  test('returns the help output when the first prompt cannot be asked', async ($, on) => {
    fakeCli(on, tokens => ({ stdout: tokens[0] === 'help' ? 'help text' : STATUS_JSON }))
    fakeUser(on, ['dismiss'])

    const result = await runCommand($, '')

    expect(result.text).toBe('help text')
  })

  test('reports a cancellation when a later prompt is dismissed', async ($, on) => {
    const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'executed' }))
    fakeUser(on, ['Settings', 'dismiss'])

    const result = await runCommand($, '')

    expect(result.text).toBe('Cancelled; no settings changed.')
    expect(calls.map(call => call.argv.slice(2))).toEqual([['status', '--json']])
  })
})

describe('useful-skills command by prompt origin', () => {
  const refusal = 'Workflow settings can only be changed from your own prompt.'

  const readOnlyOrigins: readonly PromptOrigin[] = [
    { kind: 'bridge' },
    { kind: 'task-notification' },
    { kind: 'scheduled-trigger' },
    { kind: 'peer' },
    { kind: 'peer-send-message' },
    { kind: 'projects-relay' },
    { kind: 'channel', server: 'slack' },
    { kind: 'coordinator' },
    { kind: 'observer' },
    { kind: 'observer-activity' },
    { kind: 'auto-continuation' },
    { kind: 'unclassified' },
    { kind: 'slack-ping' },
    { kind: 'plugin', name: 'other-plugin' },
    { kind: 'plugin', name: 'other-plugin', asUser: true },
  ]

  for (const origin of readOnlyOrigins) {
    const label = origin.kind === 'plugin' && origin.asUser ? 'plugin (asUser)' : origin.kind

    describe(label, () => {
      test('refuses to change the workflow and does not run the CLI', async ($, on) => {
        const calls = fakeCli(on, () => ({ stdout: 'changed' }))

        const result = await runCommand($, 'workflow disabled', origin)

        expect(result.text).toBe(refusal)
        expect(calls).toHaveLength(0)
      })

      test('refuses to change a stage and does not run the CLI', async ($, on) => {
        const calls = fakeCli(on, () => ({ stdout: 'changed' }))

        const result = await runCommand($, 'stage security-review disabled', origin)

        expect(result.text).toBe(refusal)
        expect(calls).toHaveLength(0)
      })

      test('runs read-only subcommands', async ($, on) => {
        const calls = fakeCli(on, () => ({ stdout: 'status text' }))

        const result = await runCommand($, 'status', origin)

        expect(result.text).toBe('status text')
        expect(calls.map(call => call.argv.slice(2))).toEqual([['status']])
      })

      test('answers an empty command with help instead of the settings menu', async ($, on) => {
        const calls = fakeCli(on, () => ({ stdout: 'help text' }))
        const asked = fakeUser(on, ['Settings'])

        const result = await runCommand($, '', origin)

        expect(result.text).toBe('help text')
        expect(asked).toHaveLength(0)
        expect(calls.map(call => call.argv.slice(2))).toEqual([['help']])
      })

      test('only checks memory for doctor, without a toast', async ($, on) => {
        const calls = fakeCli(on, () => ({ stdout: 'memory: ok' }))
        const toasts = fakeToasts(on)

        const setup = await runCommand($, 'doctor', origin)
        const check = await runCommand($, 'doctor --check', origin)

        expect(setup.text).toBe('memory: ok')
        expect(check.text).toBe('memory: ok')
        expect(toasts).toHaveLength(0)
        expect(calls.map(call => call.argv.slice(2))).toEqual([
          ['doctor', '--check'],
          ['doctor', '--check'],
        ])
      })

      test('answers other doctor arguments with usage and does not run the CLI', async ($, on) => {
        const calls = fakeCli(on, () => ({ stdout: 'ran' }))

        const result = await runCommand($, 'doctor foo', origin)

        expect(result.text).toContain('Usage: /useful-skills')
        expect(calls).toHaveLength(0)
      })
    })
  }

  test('treats a missing or unknown origin as read-only', async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'status text' }))
    const asked = fakeUser(on, ['Settings'])
    const missing = null as unknown as PromptOrigin
    const unknown = { kind: 'something-new' } as unknown as PromptOrigin

    for (const origin of [missing, unknown]) {
      const refused = await runCommand($, 'workflow disabled', origin)
      const status = await runCommand($, 'status', origin)
      const help = await runCommand($, '', origin)

      expect(refused.text).toBe(refusal)
      expect(status.text).toBe('status text')
      expect(help.text).toBe('status text')
    }

    expect(asked).toHaveLength(0)
    expect(calls.map(call => call.argv.slice(2))).toEqual([['status'], ['help'], ['status'], ['help']])
  })

  test('only checks memory for doctor from a missing or unknown origin', async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'memory: ok' }))
    const toasts = fakeToasts(on)
    const missing = null as unknown as PromptOrigin
    const unknown = { kind: 'something-new' } as unknown as PromptOrigin

    for (const origin of [missing, unknown]) {
      const setup = await runCommand($, 'doctor', origin)
      const other = await runCommand($, 'doctor foo', origin)

      expect(setup.text).toBe('memory: ok')
      expect(other.text).toContain('Usage: /useful-skills')
    }

    expect(toasts).toHaveLength(0)
    expect(calls.map(call => call.argv.slice(2))).toEqual([
      ['doctor', '--check'],
      ['doctor', '--check'],
    ])
  })

  const writeOrigins: readonly PromptOrigin[] = [{ kind: 'composer' }, { kind: 'sdk' }]

  for (const origin of writeOrigins) {
    describe(origin.kind, () => {
      test('runs state-changing subcommands', async ($, on) => {
        const calls = fakeCli(on, () => ({ stdout: 'changed' }))

        const workflow = await runCommand($, 'workflow disabled', origin)
        const stage = await runCommand($, 'stage security-review disabled', origin)

        expect(workflow.text).toBe('changed')
        expect(stage.text).toBe('changed')
        expect(calls.map(call => call.argv.slice(2))).toEqual([
          ['workflow', 'disabled'],
          ['stage', 'security-review', 'disabled'],
        ])
      })

      test('opens the settings menu for an empty command', async ($, on) => {
        const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'Workflow: disabled.' }))
        const asked = fakeUser(on, ['Settings', 'Repository workflow (enabled)', 'Disabled'])

        const result = await runCommand($, '', origin)

        expect(result.text).toBe('Workflow: disabled.')
        expect(asked[0]!.options).toEqual(['Settings', 'Status', 'Browse', 'Help'])
        expect(calls.map(call => call.argv.slice(2))).toEqual([['status', '--json'], ['workflow', 'disabled']])
      })
    })
  }
})
