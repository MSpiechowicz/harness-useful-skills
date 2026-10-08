import type { On, PromptOrigin } from 'claude-code'
import type { Engine } from 'claude-code/testing'

type Call = { argv: readonly string[]; env?: Record<string, string>; timeoutMs?: number }
type CliReply = { exitCode?: number; stdout?: string; stderr?: string }

export const STATUS_JSON = JSON.stringify({
  workflow: { saved: 'enabled', effective: 'enabled', source: 'file' },
  stages: {
    research: { saved: 'enabled', effective: 'enabled', source: 'default' },
    plan: { saved: 'disabled', effective: 'disabled', source: 'file' },
  },
})

/** Stands in for the OS beneath the plugin: records each CLI call and answers from `reply`. */
export function fakeCli(on: On, reply: (tokens: readonly string[]) => CliReply | 'unavailable') {
  const calls: Call[] = []

  on('session.cwd', () => ({ value: '/work/repo/sub' }))
  on('session.root', () => ({ value: '/work/repo' }))

  on('process.run', (_$, e) => {
    calls.push({ argv: e.argv, env: e.init?.env, timeoutMs: e.init?.timeoutMs })

    const answer = reply(e.argv.slice(2))

    if (answer === 'unavailable') {
      return { deny: 'spawn node ENOENT /secret/path' }
    }

    return {
      value: {
        exitCode: answer.exitCode ?? 0,
        stdout: answer.stdout ?? '',
        stderr: answer.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  return calls
}

/** Answers each AskUserQuestion with the next scripted label, or rejects when `answers` runs out. */
export function fakeUser(on: On, answers: readonly (string | 'dismiss')[]) {
  const asked: { question: string; options: string[] }[] = []
  let next = 0

  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const [question] = e.questions
    asked.push({ question: question!.question, options: question!.options.map(option => option.label) })

    const answer = answers[next++]

    if (answer === undefined || answer === 'dismiss') {
      return { deny: 'dismissed' }
    }

    return { result: { questions: e.questions, answers: { [question!.question]: answer } } }
  })

  return asked
}

/**
 * Records each toast; `unavailable` refuses them, as a surface with nowhere to draw one,
 * and `rejected` fails them later, as a surface that gives up after accepting one.
 */
export function fakeToasts(on: On, outcome: 'shown' | 'unavailable' | 'rejected' = 'shown') {
  const toasts: string[] = []

  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)

    if (outcome === 'rejected') {
      await Promise.resolve()
      throw new Error('surface went away')
    }

    return outcome === 'shown' ? { value: undefined } : { deny: 'no surface' }
  })

  return toasts
}

/** A clock the test moves by hand: `$.clock.now()` answers `clock.now`. */
export function fakeClock(on: On) {
  const clock = { now: 1_000 }

  on('clock.now', () => ({ value: clock.now }))

  return clock
}

export async function runCommand($: Engine, args: string, origin: PromptOrigin = { kind: 'composer' }) {
  return $.command.run({
    command: 'useful-skills',
    args,
    origin,
    presentation: { isFullscreen: false, columns: 80 },
  })
}
