# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码库中工作时提供指导。

## 构建、测试和运行命令

```bash
npm run build       # TypeScript 编译 → dist/
npm run dev         # 监视模式编译
npm test            # 运行所有 Vitest 测试
npm test -- src/tools/read.test.ts  # 运行单个测试文件
npm run test:watch  # 监视模式测试
npm start           # 运行 CLI REPL（需要设置 ANTHROPIC_API_KEY 环境变量）
node dist/cli.js -p "..."  # 单次执行模式
```

## 架构

### 核心循环 (`src/core/agent.ts`)
Agent 循环是一个异步生成器（`agentLoop`），它产生 `StreamEvent` 流。循环过程：
1. 自动压缩检查（当上下文接近限制时触发）
2. 调用 Claude API（流式）
3. 收集 tool_use 块
4. 检查每个工具的权限
5. 执行工具（只读工具并行，写工具串行）
6. 累积结果并重复

### 工具系统 (`src/tools/`)
- 通过 `ToolDef` 接口定义工具，使用 Zod schema
- `isConcurrencySafe` 和 `isReadOnly` 决定执行策略
- 只读工具（Glob、Grep、Read、安全的 Bash）并行运行
- 写工具（Edit、Write、Bash）串行运行
- 工具使用 `buildTool()` 模式，默认关闭安全检查

### 3层上下文压缩
1. **自动压缩**：通过 `src/context/compaction.ts` 中的 `compact()` 对旧消息进行摘要
2. **微压缩**：`agent.ts:microCompactMessages` 截断 > 50K 字符的工具结果
3. **压缩后恢复**：压缩后重新注入前 5 个文件（50K token 预算）

### 流式执行器 (`src/core/streaming-executor.ts`)
- 按并发安全性对工具进行分区
- 只读工具并行执行（有限流）
- 写工具串行执行
- 产生 `tool_start`、`tool_result` 事件

### 会话持久化 (`src/context/session.ts`)
- 会话以 JSONL 格式存储在 `~/.nanocode/sessions/`
- 每条消息立即追加（延迟初始化）
- 压缩边界标记摘要发生的位置

### 权限系统 (`src/permissions/`)
- 4 种模式：`default`、`plan`、`acceptEdits`、`bypassPermissions`
- `plan` 模式：仅允许只读工具
- `acceptEdits` 模式：自动允许 Edit/Write/NotebookEdit
- 路径验证：防止 `..` 遍历和敏感路径

## 关键模式

**工具定义**：使用 `registerToolDef()`，配合 Zod 输入 schema、`isReadOnly()` 和 `isConcurrencySafe()` 谓词。

**Edit 工具**：字符串替换模式——必须匹配包括空白在内的确切文本。在执行前验证唯一性。

**原子写入** (`src/files/atomic-write.ts`)：写入临时文件 → rename（带回退）。失败时保留现有文件。

**文件缓存** (`src/files/cache.ts`)：LRU 缓存，25MB/100 文件限制。追踪 offset/limit 以支持部分读取。

**Token 估算**：文本 4 字符/token，JSON 2 字符/token。压缩阈值：`contextWindow - maxOutputTokens - 13,000`。

## 文件结构

```
src/
├── cli.ts              # CLI 入口 + REPL（readline、建议、多行输入）
├── headless.ts         # SDK/程序化模式入口
├── core/               # Agent 循环、API 客户端、流式执行器、错误、类型
├── prompt/             # 系统提示词、压缩提示词、缓存边界
├── context/            # 压缩、会话、token 计数、内存、git 上下文
├── tools/             # 15 个工具 + 注册表
├── skills/            # 技能发现、加载、执行
├── files/             # 历史（撤销/重做）、缓存、原子写入
├── permissions/      # 权限引擎、规则、路径验证、模式
├── mcp/               # MCP stdio 客户端
├── commands/          # 16 个斜杠命令
└── utils/             # 成本追踪、ANSI 格式化、旋转动画、流式处理
```

## 环境要求

- 需要设置 `ANTHROPIC_API_KEY` 环境变量（或使用 `--api-key` 参数）
- Node.js >= 18.0.0
- 项目使用 ES modules（package.json 中 `"type": "module"`）
- TypeScript 严格模式已启用
