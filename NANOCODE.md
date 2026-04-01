# NanoCode Agent Guide

## Commands

```bash
# Build and test
npm run build              # Compile TypeScript → dist/
npm run dev               # Watch mode compilation
npm run test              # Run Vitest tests
npm run test:watch        # Watch mode tests

# Run agent
npm start                 # Start CLI REPL (requires ANTHROPIC_API_KEY)
node dist/cli.js -p "..."  # One-shot mode
node dist/cli.js --model sonnet --thinking  # Extended reasoning mode
node dist/cli.js --resume <session-id>      # Resume previous session
```

## Slash Commands (in REPL)

```
/compact               # Compress conversation history
/clear                # Clear message history
/help                 # List all commands
/model <name>         # Switch model (sonnet, haiku, opus)
/cost                 # Show token usage and costs
/resume <session-id>  # Load previous session
/plan                 # Enter planning mode
/diff                 # Show recent file changes
/memory               # Show loaded CLAUDE.md content
/undo                 # Revert last file operation
/status               # Show current session info
/config               # Display configuration
```

## Architecture Patterns

**Tool Factory Pattern**: All tools use `buildTool()` with fail-closed defaults
- `isConcurrencySafe` defaults to `false`
- `isReadOnly` defaults to `false`  
- Tools register via `registerToolDef()`

**Streaming Execution**: Tools partitioned by concurrency safety
- Read-only tools (Glob, Grep, Read, safe Bash) → parallel execution  
- Write tools (Edit, Write, unsafe Bash) → serial execution
- 30-50% latency reduction on multi-tool turns

**3-Layer Context Compression**:
1. Auto-compact when near context limit
2. Micro-compact preserves last 3 turns verbatim
3. Post-compact file restoration (50K token budget)

**Permission System**: 4 modes via `--permission-mode`
- `default`: Ask for destructive actions
- `plan`: Read-only tools only
- `acceptEdits`: Auto-allow file edits
- `bypassPermissions`: Allow everything

**Session Persistence**: JSONL append-only logs in `logs/`
- Each message appended immediately  
- Compact boundary markers for resumption
- Fork sessions with `--resume <id>`

## Code Style Rules

- **Fail-closed security**: Default to `false` for safety flags
- **Read-before-edit**: Tools validate file exists before editing
- **Atomic writes**: Temp file → rename (with fallback)
- **String-replace edits**: Edit tool uses exact text matching, not line numbers
- **LRU file cache**: 25MB/100 file limit to avoid re-reading
- **Token estimation**: 4 chars/token (JSON: 2 chars/token)

## File Structure

```
src/
├── core/           # Agent loop, API client, streaming executor, types
├── tools/          # 11 core tools + registry + MCP wrapper  
├── prompt/         # System prompt, compaction prompts, cache boundaries
├── context/        # Compaction, memory, git context, sessions, tokens
├── files/          # History (undo/redo), cache, atomic writes
├── permissions/    # Engine, rules, path validation, modes
├── skills/         # .claude/skills/ loader + execution
├── commands/       # 12 slash commands
├── mcp/            # MCP stdio client for tool ecosystem
└── utils/          # Cost tracking, formatting, streaming, process mgmt
```

## Key Gotchas

- **ANTHROPIC_API_KEY required**: Set env var or use `--api-key`
- **Read-only Bash auto-allowlist**: `cat`, `ls`, `pwd`, etc. bypass permissions
- **Edit tool needs exact match**: Must specify exact text to replace
- **Skill files**: `.claude/skills/*/SKILL.md` with frontmatter for custom prompts
- **Context window**: Auto-compacts at `contextWindow - maxOutput - 13K` tokens
- **Git context**: Only captured at session start, not live-updated
- **MCP tools**: Added dynamically, don't appear in initial tool registry
- **Plan mode**: Disables write tools, enables multi-step research workflows

## Non-obvious Workflows

**File editing**: Always `Read` → `Edit` → optionally `Read` to verify
**Codebase exploration**: Use `Glob` patterns → `Grep` specific terms → `Read` matches  
**Multi-step tasks**: Use `/plan` mode or `Agent` tool for complex research
**Permission tuning**: Start `default` → use `acceptEdits` for file-heavy work
**Long sessions**: Monitor `/cost`, use `/compact` before hitting limits
**Skill development**: Create `.claude/skills/name/SKILL.md` for reusable prompts