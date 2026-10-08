import { describe, expect, test } from 'claude-code/testing'

import { fakeCli, fakeClock, fakeToasts, fakeUser, runCommand, STATUS_JSON } from './register-test-helpers'

describe('useful-skills doctor', () => {
  const preparing = 'Useful Skills doctor: preparing memory; first setup can take several minutes'

  test('prepares memory in the project root with a ten-minute timeout and a toast', async ($, on) => {
    fakeClock(on)
    const calls = fakeCli(on, () => ({ stdout: 'memory ready' }))
    const toasts = fakeToasts(on)

    const result = await runCommand($, 'doctor')

    expect(result.text).toBe('memory ready')
    expect(toasts).toEqual([preparing])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv.slice(2)).toEqual(['doctor'])
    expect(calls[0]!.timeoutMs).toBe(600000)
    expect(calls[0]!.env).toMatchObject({ CLAUDE_PROJECT_DIR: '/work/repo', CLAUDE_PLUGIN_OPTION_WORKFLOW: 'true' })
  })

  test('checks without a toast when asked for --check', async ($, on) => {
    const calls = fakeCli(on, () => ({ stdout: 'memory: ok' }))
    const toasts = fakeToasts(on)

    const result = await runCommand($, 'doctor --check')

    expect(result.text).toBe('memory: ok')
    expect(toasts).toHaveLength(0)
    expect(calls.map(call => call.argv.slice(2))).toEqual([['doctor', '--check']])
    expect(calls[0]!.env).toMatchObject({ CLAUDE_PROJECT_DIR: '/work/repo' })
  })

  test('still prepares memory when the toast cannot be shown', async ($, on) => {
    fakeClock(on)
    const calls = fakeCli(on, () => ({ stdout: 'memory ready' }))
    fakeToasts(on, 'unavailable')

    const result = await runCommand($, 'doctor')

    expect(result.text).toBe('memory ready')
    expect(calls.map(call => call.argv.slice(2))).toEqual([['doctor']])
  })

  test('still prepares memory when the toast fails after being accepted', async ($, on) => {
    fakeClock(on)
    const calls = fakeCli(on, () => ({ stdout: 'memory ready' }))
    const toasts = fakeToasts(on, 'rejected')

    const result = await runCommand($, 'doctor')

    expect(result.text).toBe('memory ready')
    expect(toasts).toEqual([preparing])
    expect(calls.map(call => call.argv.slice(2))).toEqual([['doctor']])
  })

  test('reports a setup cut off by the timeout as possibly partial', async ($, on) => {
    const clock = fakeClock(on)
    fakeCli(on, () => {
      clock.now += 600_000

      return 'unavailable'
    })

    const result = await runCommand($, 'doctor')

    expect(result.text).toBe('Useful Skills doctor did not finish within 10 minutes; setup may be partial — run it again.')
  })

  test('reports a setup killed silently at the timeout as possibly partial', async ($, on) => {
    const clock = fakeClock(on)
    fakeCli(on, () => {
      clock.now += 600_000

      return { exitCode: 1 }
    })

    const result = await runCommand($, 'doctor')

    expect(result.text).toBe('Useful Skills doctor did not finish within 10 minutes; setup may be partial — run it again.')
  })

  test('reports a quick silent setup failure by its exit code', async ($, on) => {
    const clock = fakeClock(on)
    fakeCli(on, () => {
      clock.now += 50

      return { exitCode: 1 }
    })

    const result = await runCommand($, 'doctor')

    expect(result.text).toBe('Useful Skills command failed (exit 1).')
  })

  test('returns the output of a setup that failed late but explained why', async ($, on) => {
    const clock = fakeClock(on)
    fakeCli(on, () => {
      clock.now += 600_000

      return { exitCode: 1, stderr: 'graphify install failed\n' }
    })

    const result = await runCommand($, 'doctor')

    expect(result.text).toBe('graphify install failed')
  })

  test('reports a setup that could not start as missing Node.js', async ($, on) => {
    const clock = fakeClock(on)
    fakeCli(on, () => {
      clock.now += 50

      return 'unavailable'
    })

    const result = await runCommand($, 'doctor')

    expect(result.text).toBe('Useful Skills needs Node.js 22+ on PATH to run /useful-skills.')
  })

  test('Browse, Doctor…, Set up memory prepares memory with the ten-minute timeout and a toast', async ($, on) => {
    fakeClock(on)
    const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'memory ready' }))
    const toasts = fakeToasts(on)
    const asked = fakeUser(on, ['Browse', 'Doctor…', 'Set up memory'])

    const result = await runCommand($, '')

    expect(result.text).toBe('memory ready')
    expect(asked[2]!.options).toEqual(['Set up memory', 'Check only', 'Back'])
    expect(toasts).toEqual([preparing])
    expect(calls.map(call => call.argv.slice(2))).toEqual([['status', '--json'], ['doctor']])
    expect(calls[1]!.timeoutMs).toBe(600000)
    expect(calls[0]!.timeoutMs).toBe(60000)
  })

  test('Browse, Doctor…, Check only checks memory without a toast', async ($, on) => {
    const calls = fakeCli(on, tokens => ({ stdout: tokens[0] === 'status' ? STATUS_JSON : 'memory: ok' }))
    const toasts = fakeToasts(on)
    fakeUser(on, ['Browse', 'Doctor…', 'Check only'])

    const result = await runCommand($, '')

    expect(result.text).toBe('memory: ok')
    expect(toasts).toHaveLength(0)
    expect(calls.map(call => call.argv.slice(2))).toEqual([['status', '--json'], ['doctor', '--check']])
    expect(calls[1]!.env).toMatchObject({ CLAUDE_PROJECT_DIR: '/work/repo' })
  })
})
