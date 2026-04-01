/**
 * NanoCode — Streaming Utilities
 *
 * Terminal spinner with random verbs (inspired by Claude Code's 156 verbs),
 * and async generator streaming to stdout.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 80

const SPINNER_VERBS = [
  'Analyzing', 'Architecting', 'Bootstrapping', 'Calculating', 'Cerebrating',
  'Compiling', 'Composing', 'Computing', 'Considering', 'Constructing',
  'Crafting', 'Debugging', 'Deciphering', 'Deliberating', 'Designing',
  'Encoding', 'Engineering', 'Evaluating', 'Exploring', 'Formulating',
  'Generating', 'Hypothesizing', 'Implementing', 'Inspecting', 'Integrating',
  'Interpreting', 'Investigating', 'Iterating', 'Mapping', 'Navigating',
  'Optimizing', 'Orchestrating', 'Parsing', 'Planning', 'Pondering',
  'Processing', 'Prototyping', 'Querying', 'Reasoning', 'Refactoring',
  'Resolving', 'Reviewing', 'Searching', 'Solving', 'Structuring',
  'Synthesizing', 'Thinking', 'Transforming', 'Understanding', 'Validating',
  'Wrangling', 'Writing', 'Zigzagging',
]

function randomVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

export interface SpinnerHandle {
  stop(): void
  update(message: string): void
}

/**
 * Start a terminal spinner with a random verb.
 * Optionally shows right-aligned stats.
 */
export function spinner(message?: string, stats?: string): SpinnerHandle {
  let frameIndex = 0
  let currentMessage = message || `${randomVerb()}…`
  let currentStats = stats || ''
  let stopped = false

  const write = (text: string): void => {
    if (process.stdout.isTTY) {
      process.stdout.write(`\r\x1b[K${text}`)
    }
  }

  const render = () => {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length]
    const left = `  \x1b[38;2;230;190;80m${frame} ${currentMessage}\x1b[0m`
    if (currentStats && process.stdout.columns) {
      const statsText = `\x1b[2m${currentStats}\x1b[0m`
      const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
      const pad = Math.max(1, process.stdout.columns - stripAnsi(left).length - stripAnsi(statsText).length - 2)
      write(`${left}${' '.repeat(pad)}${statsText}`)
    } else {
      write(left)
    }
  }

  const interval = setInterval(() => {
    if (stopped) return
    frameIndex++
    render()
  }, SPINNER_INTERVAL_MS)

  // Draw immediately
  render()

  return {
    stop(): void {
      if (stopped) return
      stopped = true
      clearInterval(interval)
      if (process.stdout.isTTY) {
        process.stdout.write('\r\x1b[K')
      }
    },

    update(msg: string): void {
      currentMessage = msg
    },
  }
}

// ---------------------------------------------------------------------------
// Stream to terminal
// ---------------------------------------------------------------------------

export async function streamToTerminal(
  gen: AsyncGenerator<string, void, unknown>,
): Promise<void> {
  for await (const chunk of gen) {
    process.stdout.write(chunk)
  }
}

export { SPINNER_VERBS }
