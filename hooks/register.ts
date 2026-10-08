import type { EngineInterface, PluginOptions, Register } from 'claude-code'

// Claude Code function-hooks module: `/useful-skills`, backed by claude/command.js.

const COMMAND_TIMEOUT_MS = 60_000
const MAX_TOKENS = 8

const NODE_REQUIRED = 'Useful Skills needs Node.js 22+ on PATH to run /useful-skills.'
const FAILED = 'Useful Skills could not complete /useful-skills.'
const CANCELLED = 'Cancelled; no settings changed.'
const NO_CHANGE = 'No change.'
const NO_OUTPUT = 'Useful Skills command produced no output; nothing was confirmed.'
const WRITE_REFUSED = 'Workflow settings can only be changed from your own prompt.'
const USAGE = [
  `Too many arguments (at most ${MAX_TOKENS}).`,
  'Usage: /useful-skills [status|workflow|stage|list|library|doctor|help]',
  'Run /useful-skills help for the full list.',
].join('\n')

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

// Every other subcommand can change saved settings.
const READ_ONLY: ReadonlySet<string> = new Set(['status', 'help', 'list', 'library', 'doctor', 'update', 'graph'])

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

class CliUnavailable extends Error {}

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
): Promise<{ exitCode: number; text: string }> {
  try {
    const cwd = await $.session.cwd()
    const result = await $.process.run(['node', `${$.plugin.root}/claude/command.js`, ...tokens], {
      cwd,
      env,
      timeoutMs: COMMAND_TIMEOUT_MS,
    })
    const text = result.stdout.trim() || result.stderr.trim()

    return { exitCode: result.exitCode, text }
  } catch {
    throw new CliUnavailable()
  }
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

  const browse: Menu = {
    question: 'What would you like to browse?',
    header: 'Browse',
    choices: [
      { label: 'List', command: ['list'] },
      { label: 'Libraries', command: ['library', 'list'] },
      { label: 'Doctor', command: ['doctor'] },
      { label: 'Back', back: true },
    ],
  }

  return {
    question: 'What would you like to do?',
    header: 'Useful',
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
      argumentHint: '[status|workflow|stage|list|library|doctor|help]',
    })

    return started
  })

  on('command.run', { command: 'useful-skills' }, async ($, e) => {
    const run: Run = async tokens => {
      const { exitCode, text } = await runCli($, env, tokens)

      if (text) {
        return text
      }

      // Silence is never success: a CLI that did nothing must not be reported as done.
      return exitCode === 0 ? NO_OUTPUT : `Useful Skills command failed (exit ${exitCode}).`
    }

    try {
      const tokens = e.args.trim().split(/\s+/).filter(Boolean)

      if (tokens.length > MAX_TOKENS) {
        return { text: USAGE }
      }

      // Fail closed: a missing or unrecognized origin is read-only, with no menu.
      const kind: unknown = e.origin?.kind

      if (typeof kind !== 'string' || !WRITE_ORIGINS.has(kind)) {
        if (tokens.length === 0) {
          return { text: await run(['help']) }
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
      return { text: error instanceof CliUnavailable ? NODE_REQUIRED : FAILED }
    }
  })
}
