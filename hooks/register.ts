import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// Claude Code function-hooks module: `/useful-skills`, backed by claude/command.js.

const COMMAND_TIMEOUT_MS = 60_000
const DOCTOR_TIMEOUT_MS = 600_000
const MAX_ARGUMENTS = 8

const NODE_REQUIRED = 'Useful Skills needs Node.js 22+ on PATH to run /useful-skills.'
const FAILED = 'Useful Skills could not complete /useful-skills.'
const CANCELLED = 'Cancelled; no settings changed.'
const NO_CHANGE = 'No change.'
const NO_OUTPUT = 'Useful Skills command produced no output; nothing was confirmed.'
const WRITE_REFUSED = 'Workflow settings can only be changed from your own prompt.'
const DOCTOR_PREPARING = 'Useful Skills doctor: preparing memory; first setup can take several minutes'
const DOCTOR_TIMED_OUT = 'Useful Skills doctor did not finish within 10 minutes; setup may be partial — run it again.'
const USAGE = [
  'Usage: /useful-skills [status|workflow|stage|list|doctor|help]',
  'Run /useful-skills help for the full list.',
].join('\n')
const TOO_MANY_ARGUMENTS = [`Too many arguments (at most ${MAX_ARGUMENTS}).`, USAGE].join('\n')

// `doctor` alone prepares memory (writes); `doctor --check` only reports.
const DOCTOR_SETUP: readonly string[] = ['doctor']
const DOCTOR_CHECK: readonly string[] = ['doctor', '--check']

// Boolean plugin options travel to the CLI as the env vars Claude gives hook processes.
const OPTION_ENV: Readonly<Record<string, string>> = {
  workflow: 'CLAUDE_PLUGIN_OPTION_WORKFLOW',
  research: 'CLAUDE_PLUGIN_OPTION_RESEARCH',
  plan: 'CLAUDE_PLUGIN_OPTION_PLAN',
  review: 'CLAUDE_PLUGIN_OPTION_REVIEW',
  security_review: 'CLAUDE_PLUGIN_OPTION_SECURITY_REVIEW',
  backend_memory: 'CLAUDE_PLUGIN_OPTION_BACKEND_MEMORY',
  graphify_memory: 'CLAUDE_PLUGIN_OPTION_GRAPHIFY_MEMORY',
}

// Only these origins are the person's own prompt; every other origin may only read.
const WRITE_ORIGINS: ReadonlySet<string> = new Set(['composer', 'sdk'])

// Every other subcommand can change saved settings; `doctor` from these origins only checks.
const READ_ONLY: ReadonlySet<string> = new Set(['status', 'help', 'list', 'doctor', 'update', 'graph'])

type Stage = { key: string; label: string }

const STAGES_FIRST: readonly Stage[] = [
  { key: 'research', label: 'Research' },
  { key: 'plan', label: 'Plan' },
  { key: 'review', label: 'Review' },
]
const STAGES_SECOND: readonly Stage[] = [
  { key: 'security-review', label: 'Security review' },
  { key: 'backend-memory', label: 'Backend memory' },
  { key: 'graphify-memory', label: 'Graphify memory' },
]

type Run = (tokens: readonly string[]) => Promise<string>

/** A menu entry either opens a submenu, goes back, or runs one CLI command. */
type Choice = { label: string; menu?: Menu; command?: readonly string[]; back?: true }
type Menu = { question: string; header: string; choices: readonly Choice[] }

type CliResult = { exitCode: number; text: string }
type CliRunOptions = { timeoutMs?: number; extraEnv?: Record<string, string> }

class CliUnavailable extends Error {}
class DoctorTimedOut extends Error {}

function optionEnvironment(options: PluginOptions): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [field, name] of Object.entries(OPTION_ENV)) {
    const value = options[field]

    if (typeof value === 'boolean') {
      env[name] = value ? 'true' : 'false'
    }
  }

  return env
}

/** Runs the CLI and returns its output; a failure to start it is never described in detail. */
async function runCli(
  $: EngineInterface,
  env: Record<string, string>,
  tokens: readonly string[],
  options: CliRunOptions = {},
): Promise<CliResult> {
  try {
    const cwd = await $.session.cwd()
    const result = await $.process.run(['node', `${$.plugin.root}/claude/command.js`, ...tokens], {
      cwd,
      env: { ...env, ...options.extraEnv },
      timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    })
    const text = result.stdout.trim() || result.stderr.trim()

    return { exitCode: result.exitCode, text }
  } catch {
    throw new CliUnavailable()
  }
}

function sameTokens(tokens: readonly string[], expected: readonly string[]): boolean {
  return tokens.length === expected.length && tokens.every((token, index) => token === expected[index])
}

/** A toast is only a hint: one that cannot be shown, now or later, never stops the command. */
function showToast($: EngineInterface, text: string): void {
  try {
    const shown: unknown = $.ui.toast(text)

    // Not awaited: a toast that fails later is dropped, never an unhandled rejection.
    Promise.resolve(shown).catch(() => {})
  } catch {
    // No surface to show it on; the command still runs.
  }
}

/** Full memory setup: may run for minutes, so it gets the longest timeout the host allows. */
async function runDoctorSetup($: EngineInterface, env: Record<string, string>, extraEnv: Record<string, string>): Promise<CliResult> {
  showToast($, DOCTOR_PREPARING)

  const startedAt = await $.clock.now()
  const hasTimedOut = async () => (await $.clock.now()) - startedAt >= DOCTOR_TIMEOUT_MS
  let result: CliResult

  try {
    result = await runCli($, env, DOCTOR_SETUP, { timeoutMs: DOCTOR_TIMEOUT_MS, extraEnv })
  } catch (error) {
    if (await hasTimedOut()) {
      throw new DoctorTimedOut()
    }

    throw error
  }

  // A host may report a run it killed at the limit as a silent failure (a signal reads as exit 1).
  const isSilentFailure = result.exitCode !== 0 && !result.text

  if (isSilentFailure && (await hasTimedOut())) {
    throw new DoctorTimedOut()
  }

  return result
}

/** Runs one command; every `doctor` run is told the session's project root. */
async function runTokens($: EngineInterface, env: Record<string, string>, tokens: readonly string[]): Promise<CliResult> {
  if (tokens[0] !== 'doctor') {
    return runCli($, env, tokens)
  }

  const extraEnv = { CLAUDE_PROJECT_DIR: await $.session.root() }

  if (sameTokens(tokens, DOCTOR_SETUP)) {
    return runDoctorSetup($, env, extraEnv)
  }

  return runCli($, env, tokens, { extraEnv })
}

/** Saved enabled/disabled values by key; empty when the CLI cannot report them. */
async function readSaved($: EngineInterface, env: Record<string, string>): Promise<Record<string, string>> {
  const saved: Record<string, string> = {}

  try {
    const { exitCode, text } = await runCli($, env, ['status', '--json'])

    if (exitCode !== 0) {
      return saved
    }

    const status = JSON.parse(text)
    const entries: Record<string, unknown> = { workflow: status?.workflow, ...status?.stages }

    for (const [key, entry] of Object.entries(entries)) {
      const value = (entry as { saved?: unknown } | undefined)?.saved

      if (value === 'enabled' || value === 'disabled' || value === 'unknown') {
        saved[key] = value
      }
    }
  } catch {
    return {}
  }

  return saved
}

function modeMenu(title: string, header: string, saved: string, subject: readonly string[]): Menu {
  return {
    question: `Set ${title} (saved: ${saved})?`,
    header,
    choices: [
      { label: 'Enabled', command: [...subject, 'enabled'] },
      { label: 'Disabled', command: [...subject, 'disabled'] },
      { label: 'Back', back: true },
    ],
  }
}

function stagesMenu(header: string, stages: readonly Stage[], saved: Record<string, string>): Menu {
  const choices: Choice[] = stages.map(stage => {
    const current = saved[stage.key] ?? 'unknown'

    return {
      label: `${stage.label} (${current})`,
      menu: modeMenu(`${stage.label} stage`, 'Stage', current, ['stage', stage.key]),
    }
  })

  return { question: 'Which stage?', header, choices: [...choices, { label: 'Back', back: true }] }
}

function buildMenu(saved: Record<string, string>): Menu {
  const workflow = saved.workflow ?? 'unknown'

  const settings: Menu = {
    question: 'Which setting?',
    header: 'Settings',
    choices: [
      {
        label: `Repository workflow (${workflow})`,
        menu: modeMenu('repository workflow', 'Workflow', workflow, ['workflow']),
      },
      { label: 'Stages 1/2', menu: stagesMenu('Stages 1/2', STAGES_FIRST, saved) },
      { label: 'Stages 2/2', menu: stagesMenu('Stages 2/2', STAGES_SECOND, saved) },
      { label: 'Back', back: true },
    ],
  }

  // Setup installs and writes; checking only reports. The person picks which, never by default.
  const doctor: Menu = {
    question: 'Doctor: set up memory (may install and write files) or only check it?',
    header: 'Doctor',
    choices: [
      { label: 'Set up memory', command: DOCTOR_SETUP },
      { label: 'Check only', command: DOCTOR_CHECK },
      { label: 'Back', back: true },
    ],
  }

  const browse: Menu = {
    question: 'What would you like to browse?',
    header: 'Browse',
    choices: [
      { label: 'List', command: ['list'] },
      { label: 'Doctor…', menu: doctor },
      { label: 'Back', back: true },
    ],
  }

  return {
    question: 'Useful Skills: what would you like to do?',
    header: 'Menu',
    choices: [
      { label: 'Settings', menu: settings },
      { label: 'Status', command: ['status'] },
      { label: 'Browse', menu: browse },
      { label: 'Help', command: ['help'] },
    ],
  }
}

/** Walks the menu tree; only an exact option label ever reaches the CLI. */
async function chooseAndRun($: EngineInterface, run: Run, saved: Record<string, string>): Promise<string> {
  const path: Menu[] = [buildMenu(saved)]
  let hasAsked = false

  for (;;) {
    const menu = path[path.length - 1]!
    let answer: string

    try {
      answer = await $.ui.ask(menu.question, { options: menu.choices.map(choice => choice.label), header: menu.header })
    } catch {
      // Dismissed, or no UI to ask in (`-p`): help before any prompt, otherwise cancel.
      return hasAsked ? CANCELLED : run(['help'])
    }

    hasAsked = true

    const choice = menu.choices.find(entry => entry.label === answer)

    if (!choice) {
      return NO_CHANGE
    }

    if (choice.back) {
      path.pop()
    } else if (choice.menu) {
      path.push(choice.menu)
    } else if (choice.command) {
      return run(choice.command)
    }
  }
}

export const register: Register = (on, options) => {
  const env = optionEnvironment(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'useful-skills',
      description: 'Workflow settings, status, skills, and health for Useful Skills',
      argumentHint: '[status|workflow|stage|list|doctor|help]',
    })

    return started
  })

  on('command.run', { command: 'useful-skills' }, async ($, e) => {
    const run: Run = async tokens => {
      const { exitCode, text } = await runTokens($, env, tokens)

      if (text) {
        return text
      }

      // Silence is never success: a CLI that did nothing must not be reported as done.
      return exitCode === 0 ? NO_OUTPUT : `Useful Skills command failed (exit ${exitCode}).`
    }

    try {
      const tokens = e.args.trim().split(/\s+/).filter(Boolean)

      if (tokens.length > MAX_ARGUMENTS) {
        return { text: TOO_MANY_ARGUMENTS }
      }

      // Fail closed: a missing or unrecognized origin is read-only, with no menu.
      const kind: unknown = e.origin?.kind

      if (typeof kind !== 'string' || !WRITE_ORIGINS.has(kind)) {
        if (tokens.length === 0) {
          return { text: await run(['help']) }
        }

        // Memory setup writes, so from here `doctor` only ever checks.
        if (tokens[0] === 'doctor') {
          const isCheckable = sameTokens(tokens, DOCTOR_SETUP) || sameTokens(tokens, DOCTOR_CHECK)

          return { text: isCheckable ? await run(DOCTOR_CHECK) : USAGE }
        }

        if (!READ_ONLY.has(tokens[0]!)) {
          return { text: WRITE_REFUSED }
        }
      }

      if (tokens.length > 0) {
        return { text: await run(tokens) }
      }

      const saved = await readSaved($, env)

      return { text: await chooseAndRun($, run, saved) }
    } catch (error) {
      if (error instanceof DoctorTimedOut) {
        return { text: DOCTOR_TIMED_OUT }
      }

      if (error instanceof CliUnavailable) {
        return { text: NODE_REQUIRED }
      }

      return { text: FAILED }
    }
  })
}
