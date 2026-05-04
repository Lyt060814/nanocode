# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码库中工作时提供指导。

## 构建、测试和运行

```bash
npm run build       # TypeScript 编译 → dist/
npm run dev         # 监视模式编译
npm test            # 运行所有测试
npm start           # 运行 CLI REPL（需要 ANTHROPIC_API_KEY）
node dist/cli.js -p "..."  # 单次执行模式
```

## 架构概览

### 核心循环 (`src/core/agent.ts`)
异步生成器 `agentLoop` 产生 `StreamEvent` 流：自动压缩 → 调用 API → 收集 tool_use → 检查权限 → 执行工具 → 累积结果 → 重复

### 权限系统 (`src/permissions/`)
4 种模式：`default`、`plan`、`acceptEdits`、`bypassPermissions`

**重要**：权限检查使用 `toolContext.permissionMode`（非 `params.permissionMode`），因为 `ExitPlanMode` 工具会动态更新它。

### Plan Mode 工具 (`src/tools/plan-mode.ts`)
- `EnterPlanMode`：进入计划模式，仅允许只读操作
- `ExitPlanMode`：退出计划模式，会先询问用户确认 (y/n)
- 使用 `context.readline` 复用 CLI 的 readline 实例（避免 stdin 冲突）
- 使用 `context.setPermissionMode()` 同步更新状态

### 工具系统 (`src/tools/`)
- `ToolDef` 接口 + Zod schema
- 只读工具并行，写工具串行
- `ToolContext` 包含 `readline` 和 `setPermissionMode` 用于用户交互

### 上下文压缩
1. **自动压缩**：`compact()` 对旧消息摘要
2. **微压缩**：截断 > 50K 字符的工具结果
3. **压缩后恢复**：重新注入前 5 个文件

### 流式执行器 (`src/core/streaming-executor.ts`)
按并发安全性分区：只读并行（有限流），写串行

### 会话持久化 (`src/context/session.ts`)
JSONL 格式存储在 `~/.nanocode/sessions/`，消息立即追加

## 文件结构

```
src/
├── cli.ts              # CLI 入口 + REPL
├── core/               # Agent 循环、API、流式执行器、类型
├── prompt/             # 系统提示词
├── context/            # 压缩、会话、token 计数
├── tools/              # 15 个工具（含 plan-mode）
├── permissions/        # 权限引擎、规则、模式
├── commands/           # 斜杠命令（含 /plan 切换）
├── files/              # 缓存、原子写入
├── skills/             # 技能系统
├── mcp/                # MCP 客户端
└── utils/              # 格式化、流式处理
```

## 环境要求

- `ANTHROPIC_API_KEY` 环境变量（或 `--api-key`）
- Node.js >= 18，ES modules，TypeScript 严格模式
