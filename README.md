<div align="center">
  <h1>nanocode — Lightweight Claude Code Alternative</h1>
  <p>
    <a href="https://www.npmjs.com/package/nanocode-cli"><img src="https://img.shields.io/npm/v/nanocode-cli" alt="npm"></a>
    <img src="https://img.shields.io/badge/lines-~9K_LOC-blue" alt="Lines">
    <img src="https://img.shields.io/badge/node-≥18-green" alt="Node">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
    <a href="https://deepwiki.com/Lyt060814/nanocode"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
  </p>
</div>

**nanocode** is an ultra-lightweight reimplementation of [Claude Code](https://github.com/anthropics/claude-code) — Anthropic's official CLI agent — built from scratch by studying the [decompiled source](https://github.com/sanbuphy/claude-code-source-code) of `@anthropic-ai/claude-code` v2.1.88.

⚡ **~9,000 lines of code** (14K total with comments · 1.8% of Claude Code's ~512K) while retaining **~85-90% of agent capability**.

> **Disclaimer**: This project is for **educational, research, and technical exchange purposes only**. All architectural insights are derived from the publicly available npm package. **Commercial use is strictly prohibited.** nanocode is not affiliated with Anthropic. If any content infringes upon rights, please contact us for immediate removal.

<div align="center">
  <img src="assets/NANOCODE.png" alt="nanocode Screenshot" width="800">
</div>

---

## News

- **2026-04-01** 🚀 **nanocode v0.1.0 released!** — 9K LOC, 15 tools, 16 slash commands. `npm i -g nanocode-cli` and start coding!

- **2026-03-31** 💥💥💥 **Claude Code source leaked!** — The full TypeScript source of `@anthropic-ai/claude-code` v2.1.88 (~512K lines) was [extracted and published](https://github.com/instructkr/claw-code) from the npm package. nanocode is built from the insights gained.

---

## Why nanocode?

Claude Code is a remarkable piece of engineering — but at 512K lines, 12MB bundled, with React/Ink UI, telemetry, bridge layers, plugin marketplace, and 90+ slash commands, it's hard to study the **core patterns that actually make the agent work**.

nanocode extracts the **20 critical engineering decisions** that drive agent performance and implements them in clean, readable TypeScript:

<p align="center">
<img src="assets/pipeline.png" alt="nanocode Pipeline" width="700">
</p>

Remove any one of these and overall performance degrades. nanocode keeps them all.

---

## Claude Code vs nanocode

| | Claude Code v2.1.88 | nanocode v0.1.0 |
|---|---|---|
| **Lines of code** | ~512,000 | ~9,000 (1.8%) |
| **Bundle size** | 12MB | ~200KB |
| **Tools** | 45+ | 15 |
| **Slash commands** | 90+ | 16 |
| **Agent loop** | ✅ async generator | ✅ async generator |
| **Parallel tool execution** | ✅ StreamingToolExecutor | ✅ StreamingExecutor |
| **Context compression** | ✅ 3-layer (auto + micro + post-restore) | ✅ 3-layer (auto + micro + post-restore) |
| **Prompt caching** | ✅ static/dynamic boundary | ✅ static/dynamic boundary |
| **Bash read-only auto-approve** | ✅ 23 security checks | ✅ 10 essential checks |
| **Session persistence & resume** | ✅ JSONL | ✅ JSONL |
| **Sub-agents** | ✅ 5 modes | ✅ 3 modes (sync/async/explore) |
| **Skills system** | ✅ frontmatter + fork/inline | ✅ frontmatter + fork/inline |
| **MCP protocol** | ✅ stdio/SSE/WS | ✅ stdio |
| **CLAUDE.md / NANOCODE.md** | ✅ hierarchical loading | ✅ hierarchical loading |
| **Permission system** | ✅ allow/deny/ask + 4 modes | ✅ allow/deny/ask + 4 modes |
| **Extended thinking** | ✅ | ✅ |
| **Plan mode** | ✅ | ✅ |
| **React/Ink UI** | ✅ full TUI framework | ❌ pure ANSI (no React) |
| **Telemetry** | ✅ Datadog + 1P analytics | ❌ none |
| **Bridge/Remote** | ✅ Desktop + Cloud | ❌ local only |
| **Plugin marketplace** | ✅ | ❌ |
| **Agent teams/coordinator** | ✅ | ❌ |
| **Dependencies** | ~192 packages | 6 packages |

**What's kept**: Everything that affects agent reasoning quality — the loop, tools, context engineering, prompts, permissions.

**What's dropped**: Production wrappers — UI framework, telemetry, cloud bridge, plugin ecosystem, OAuth, 70+ niche commands.

---

## Quick Start

### Install

```bash
npm install -g nanocode-cli
```

### Configure

nanocode works with the Anthropic API or any OpenAI-compatible provider (OpenRouter, etc.):

```bash
# Anthropic direct
export ANTHROPIC_API_KEY="sk-ant-..."

# Or OpenRouter (access to all models)
export OPENROUTER_API_KEY="sk-or-..."
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
```

### Run

```bash
# Interactive REPL
nanocode

# One-shot mode
nanocode -p "fix the bug in auth.ts"

# With options
nanocode --model opus --thinking
nanocode --dangerously-skip-permissions -p "run all tests"
nanocode --resume <session-id>
```

---

## Features

### 15 Built-in Tools

| Tool | Purpose |
|------|---------|
| **Bash** | Shell command execution with read-only auto-approve |
| **Read** | File reading with line numbers, offset/limit, image support |
| **Edit** | String-replace editing with uniqueness validation |
| **Write** | Atomic file creation with directory auto-creation |
| **Glob** | Fast file pattern matching |
| **Grep** | Content search (ripgrep when available) |
| **Agent** | Sub-agent spawning (general/explore/plan) |
| **Ask** | User interaction prompts |
| **Todo** | In-memory task tracking |
| **WebFetch** | HTTP fetch with HTML→markdown conversion |
| **WebSearch** | Web search integration |
| **Skill** | Skill invocation from `.nanocode/skills/` |
| **EnterPlanMode** | Switch to read-only planning |
| **ExitPlanMode** | Return to full execution |
| **NotebookEdit** | Jupyter notebook cell editing |

### 16 Slash Commands

```
/help        Show available commands
/compact     Compact conversation context (with spinner)
/clear       Clear conversation history
/model       Show or change model
/cost        Show token usage and cost
/resume      Resume a previous session
/plan        Toggle plan mode (read-only)
/memory      Show NANOCODE.md / CLAUDE.md content
/config      Show current configuration
/status      Show session status
/skills      List available skills
/context     Show context window usage
/init        Analyze codebase and generate NANOCODE.md
/mcp         Show MCP server configuration
/exit        Exit nanocode (also: /quit)
```

### Context Engineering

- **3-layer compression**: Auto-compact (summarize old messages) → micro-compact (truncate large tool results) → post-compact file restoration (re-inject top 5 recent files)
- **Prompt caching**: Static system prompt blocks get `cache_control: ephemeral` — saves ~80% on cache hits
- **Token estimation**: 4 chars/token for text, 2 chars/token for JSON — fast enough for real-time budget checks
- **Compact threshold**: `contextWindow - maxOutputTokens - 13,000` — triggers before overflow

### Session Persistence

- Sessions stored as JSONL in `~/.nanocode/sessions/`
- Resume with `/resume` or `--resume <id>`
- Messages persisted as they're created (lazy session initialization — no empty sessions)

### Skills System

Place skills in `.nanocode/skills/` or `.claude/skills/`:

```markdown
---
name: my-skill
description: Does something useful
user-invocable: true
context: inline
---

Your skill prompt here. $ARGUMENTS will be replaced.
```

### MCP Support

Configure MCP servers in `.nanocode/settings.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}
```

### Multi-line Input

- Type `\` at end of line → continuation prompt `… `
- Option+Enter (macOS) / Alt+Enter → newline within input

---

## Configuration

nanocode supports both `.nanocode/` and `.claude/` config directories (`.nanocode/` takes priority):

| File | Purpose |
|------|---------|
| `NANOCODE.md` / `CLAUDE.md` | Project instructions (loaded into system prompt) |
| `.nanocode/settings.json` | Permissions, MCP servers |
| `.nanocode/skills/` | Custom skills |
| `.nanocode/rules/*.md` | Conditional rules |
| `NANOCODE.local.md` | Personal instructions (gitignored) |

Hierarchical loading: walks from cwd up to filesystem root, merging all found files.

---

## Architecture

```
nanocode/src/          9,147 LOC (14,317 total) across 55 files
├── cli.ts             CLI entry + REPL (readline, suggestions, multi-line)
├── headless.ts        SDK/programmatic mode
├── core/              Agent loop, API client, streaming executor, errors, types
├── prompt/            System prompt, compact prompt, agent prompts, cache boundary
├── context/           Compaction, post-compact, token counting, memory, git, sessions
├── tools/             15 tools + registry
├── skills/            Skill discovery, loading, execution
├── files/             File history, LRU cache, atomic writes
├── permissions/       Permission engine, rules, path validation, modes
├── mcp/               MCP stdio client, config, types
├── commands/          16 slash commands
└── utils/             Cost tracking, ANSI formatting, spinner, process management
```

### The Core Loop

<p align="center">
  <img src="assets/architecture.png" alt="nanocode Architecture" width="700">
</p>

---

## Development

```bash
git clone https://github.com/anthropics/nanocode.git
cd nanocode
npm install
npm run build       # compile TypeScript
npm run dev         # watch mode
npm test            # run 559 tests
npm start           # run the CLI
```

---

## Roadmap & Contributing

PRs welcome! The codebase is intentionally small and readable.

- [ ] **More providers** — Native support for OpenAI, Gemini, DeepSeek, Ollama, and other LLM providers (beyond OpenRouter passthrough)
- [ ] **More tools** — Git commit, PR review, code search with LSP, image generation
- [ ] **More slash commands** — `/diff`, `/export`, `/doctor`, `/copy`, `/vim`
- [ ] **Streaming improvements** — Server-sent events, web UI mode
- [ ] **Better MCP** — SSE/WebSocket transports, tool filtering, auto-reconnect
- [ ] **Agent teams** — Multi-agent coordination with shared task boards
- [ ] **Plugin system** — Installable tool/command packs
- [ ] **Voice mode** — Push-to-talk input via microphone
- [ ] **Web UI** — Browser-based interface alongside the terminal REPL
- [ ] **i18n** — Multilingual system prompts and UI

Pick an item and open a PR — or suggest new ideas in [Issues](https://github.com/anthropics/nanocode/issues).

---

## License

MIT License — see [LICENSE](LICENSE).

This project is for **educational and research purposes only**. Commercial use is prohibited. nanocode is not affiliated with or endorsed by Anthropic.

---

<p align="center">
  <em> Thanks for visiting ✨ nanocode!</em><br><br>
  <img src="https://visitor-badge.laobi.icu/badge?page_id=Lyt060814.nanocode&style=for-the-badge&color=00d4ff" alt="Views">
</p>
