# nanocode 编译与运行指南

## 编译

```bash
npm run build       # TypeScript 编译 → dist/
npm run dev         # 监视模式编译（开发时使用）
```

## 运行

```bash
# REPL 交互模式
npm start

# 单次执行模式
node dist/cli.js -p "你的指令"

# 或使用 npx
npx tsnode src/cli.ts -p "..."
```

## 前置要求

1. **Node.js >= 18.0.0**
2. **设置 API Key**：
   ```bash
   export ANTHROPIC_API_KEY=your-api-key-here
   ```
   或使用 `--api-key` 参数传入。

## 测试

```bash
npm test                    # 运行所有测试
npm test -- src/tools/read.test.ts  # 运行单个测试文件
npm run test:watch          # 监视模式测试
```

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

## 配置
export ANTHROPIC_API_KEY="sk-cp-9oKl_Oop560bhl4VXSAw2cAFNghMHyyIPQj1Tae9C2iJLcNTYS5hIHZYrzm6WMorZvATfuEz4_97Wyw00xMvab_NmYiDDUEGK5Fx4uCJifGHSvNCbv5vSxg"
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
export ANTHROPIC_MODEL="MiniMax-M2.7"


export OPENROUTER_API_KEY="sk-cp-9oKl_Oop560bhl4VXSAw2cAFNghMHyyIPQj1Tae9C2iJLcNTYS5hIHZYrzm6WMorZvATfuEz4_97Wyw00xMvab_NmYiDDUEGK5Fx4uCJifGHSvNCbv5vSxg"
export ANTHROPIC_AUTH_TOKEN="sk-cp-9oKl_Oop560bhl4VXSAw2cAFNghMHyyIPQj1Tae9C2iJLcNTYS5hIHZYrzm6WMorZvATfuEz4_97Wyw00xMvab_NmYiDDUEGK5Fx4uCJifGHSvNCbv5vSxg"
export ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="MiniMax-M2.7"
export ANTHROPIC_DEFAULT_OPUS_MODEL="MiniMax-M2.7"
export ANTHROPIC_DEFAULT_SONNET_MODEL="MiniMax-M2.7"
export ANTHROPIC_MODEL="MiniMax-M2.7"
export API_TIMEOUT_MS="3000000"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"

## 项目结构说明

```
.
├── CLAUDE.md                         # Claude Code 项目指导文件
├── LICENSE                           # 项目许可证
├── NANOCODE.md                       # NanoCode 介绍文档
├── READCODE.md                       # 代码阅读指南和编译运行说明
├── README.md                         # 项目 README 文档
├── assets/                           # 静态资源目录
│   ├── NANOCODE.png                  # NanoCode logo 图片
│   ├── architecture.png              # 架构图
│   └── pipeline.png                  # 流程图
├── package-lock.json                 # npm 依赖锁定文件
├── package.json                       # npm 项目配置
├── src/                              # 源代码目录
│   ├── cli.ts                        # CLI 入口 + REPL（readline、建议、多行输入）
│   ├── headless.ts                   # SDK/程序化模式入口
│   ├── commands/                     # 斜杠命令模块
│   │   └── index.ts                 # 16 个斜杠命令的注册和入口
│   ├── context/                      # 上下文管理模块
│   │   ├── compaction.ts            # 自动压缩：当上下文接近限制时触发，对旧消息进行摘要
│   │   ├── git-context.ts           # Git 上下文：获取当前分支、状态、变更等信息
│   │   ├── memory.ts                # 持久化记忆系统：跨会话记忆存储和检索
│   │   ├── post-compact.ts          # 压缩后恢复：压缩后重新注入前 5 个文件
│   │   ├── session.ts               # 会话持久化：JSONL 格式存储在 ~/.nanocode/sessions/
│   │   └── token-counting.ts        # Token 计数：估算文本和 JSON 的 token 数量
│   ├── core/                         # 核心 Agent 模块
│   │   ├── agent.ts                 # Agent 循环：异步生成器，产生 StreamEvent 流
│   │   ├── api.ts                   # Claude API 客户端：调用 Claude API（流式）
│   │   ├── errors.ts                # 错误类型定义和错误处理
│   │   ├── streaming-executor.ts     # 流式执行器：按并发安全性分区执行工具
│   │   └── types.ts                 # 核心类型定义
│   ├── files/                        # 文件操作模块
│   │   ├── atomic-write.ts          # 原子写入：写临时文件 → rename（带回退）
│   │   ├── cache.ts                 # 文件缓存：LRU 缓存，25MB/100 文件限制
│   │   ├── history.ts               # 历史记录：支持撤销/重做功能
│   │   └── utils.ts                 # 文件操作工具函数
│   ├── mcp/                          # MCP (Model Context Protocol) 模块
│   │   ├── client.ts                # MCP stdio 客户端：与 MCP 服务通信
│   │   ├── config.ts                # MCP 配置管理
│   │   ├── index.ts                 # MCP 模块入口导出
│   │   └── types.ts                 # MCP 类型定义
│   ├── permissions/                  # 权限系统模块
│   │   ├── engine.ts                # 权限引擎：执行权限检查和控制
│   │   ├── modes.ts                 # 权限模式：default、plan、acceptEdits、bypassPermissions
│   │   ├── path-validation.ts       # 路径验证：防止 .. 遍历和敏感路径访问
│   │   └── rules.ts                 # 权限规则定义
│   ├── prompt/                       # 提示词模块
│   │   ├── agent-prompts.ts         # Agent 提示词：系统提示词定义
│   │   ├── cache-boundary.ts        # 缓存边界标记：标记压缩发生位置
│   │   ├── compact-prompt.ts        # 压缩提示词：用于上下文压缩
│   │   └── system.ts                # 系统提示词模板
│   ├── skills/                       # 技能模块
│   │   ├── index.ts                 # 技能发现、加载、执行入口
│   │   ├── loader.ts                # 技能加载器：从文件系统加载技能
│   │   ├── skill-tool.ts            # 技能工具：执行技能作为工具
│   │   └── types.ts                 # 技能类型定义
│   ├── tools/                        # 工具模块（15 个工具）
│   │   ├── agent.ts                 # Agent 工具：允许递归调用 Agent
│   │   ├── ask.ts                   # Ask 工具：向用户提问
│   │   ├── bash-readonly.ts         # 只读 Bash 工具：安全的只执行命令
│   │   ├── bash.ts                  # Bash 工具：执行 shell 命令
│   │   ├── edit.ts                  # Edit 工具：字符串替换编辑文件
│   │   ├── glob.ts                  # Glob 工具：文件模式匹配
│   │   ├── grep.ts                  # Grep 工具：内容搜索
│   │   ├── mcp-wrapper.ts           # MCP 工具包装器：将 MCP 工具适配到本系统
│   │   ├── notebook-edit.ts         # Notebook 编辑工具：编辑 Jupyter notebook
│   │   ├── plan-mode.ts             # Plan 模式工具：切换到规划模式
│   │   ├── read.ts                  # Read 工具：读取文件内容
│   │   ├── registry.ts              # 工具注册表：管理所有工具定义
│   │   ├── todo.ts                  # Todo 工具：任务列表管理
│   │   ├── web-fetch.ts             # Web Fetch 工具：获取网页内容
│   │   ├── web-search.ts            # Web Search 工具：网络搜索
│   │   └── write.ts                 # Write 工具：写入文件
│   └── utils/                        # 工具函数模块
│       ├── completer.ts              # 命令补全器：REPL 命令补全
│       ├── cost.ts                   # 成本追踪：追踪 API 调用成本
│       ├── format.ts                 # ANSI 格式化工具
│       ├── process.ts                # 进程处理工具
│       └── streaming.ts              # 流式处理工具
├── test/                             # 测试目录
│   ├── context/                      # 上下文模块测试
│   │   ├── compaction.test.ts      # 压缩功能测试
│   │   ├── git-context.test.ts     # Git 上下文测试
│   │   ├── memory.test.ts          # 记忆系统测试
│   │   └── token-counting.test.ts  # Token 计数测试
│   ├── core/                        # 核心模块测试
│   │   ├── errors.test.ts          # 错误处理测试
│   │   └── streaming-executor.test.ts # 流式执行器测试
│   ├── files/                       # 文件模块测试
│   │   ├── atomic-write.test.ts    # 原子写入测试
│   │   └── history.test.ts         # 历史记录测试
│   ├── permissions/                 # 权限模块测试
│   │   ├── engine.test.ts          # 权限引擎测试
│   │   ├── modes.test.ts           # 权限模式测试
│   │   └── path-validation.test.ts # 路径验证测试
│   ├── skills/                      # 技能模块测试
│   │   ├── loader.test.ts          # 技能加载器测试
│   │   └── skill-tool.test.ts       # 技能工具测试
│   ├── tools/                       # 工具模块测试
│   │   ├── bash-readonly.test.ts  # 只读 Bash 测试
│   │   ├── edit.test.ts            # Edit 工具测试
│   │   ├── read.test.ts            # Read 工具测试
│   │   └── registry.test.ts        # 工具注册表测试
│   └── utils/                       # 工具函数测试
│       ├── cost.test.ts            # 成本追踪测试
│       └── format.test.ts          # 格式化工具测试
├── tsconfig.json                    # TypeScript 配置文件
└── vitest.config.ts                 # Vitest 测试框架配置
```