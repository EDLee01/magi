# Magi

**致力于打造最灵活、可扩展性最强的开源 AI 智能体。**

Magi 是一个运行在终端中的开源 Coding Agent，也是一套可深度定制的 Agent Runtime。与功能和运行方式相对固定的闭源 Coding Agent 不同，Magi 允许开发者自由组合模型、工具、Skill、Harness 与 Memory，并通过持久会话和多机协同，将同一个任务从本地电脑延续到局域网中的其他机器和手机审批端。

```text
$ magi
  △   Magi · 91 tools
 /✦\  cwd: ~/code/my-project
▔▔▔   model: main · claude-sonnet-4-6

  /help for commands · Ctrl+C to interrupt · /exit to quit

> refactor src/auth.ts to use the new session API
```

## 为什么做 Magi

Codex、Claude Code 等 Coding Agent 已经能够完成代码理解、文件修改、命令执行和调试等复杂任务。

但对于需要二次开发的人来说，问题往往不在于 Agent 能不能写代码，而在于：

- 能否替换模型
- 能否重新组织工具
- 能否加入自己的领域工作流
- 能否定义权限与执行边界
- 能否保留长期记忆
- 能否在不同机器之间调度任务
- 能否把一套 Coding Agent 改造成另一种垂直智能体

闭源 Coding Agent 的底层运行逻辑、能力组织方式和扩展边界主要由产品自身定义。

Magi 试图把这些部分开放出来，让开发者不仅能够使用 Agent，也能够重新组合 Agent。

## Magi 的定位

Magi 默认是一套可以直接使用的终端 Coding Agent。

同时，它也是一套用于构建、运行和交付其他智能体的 Runtime。

对于科研 Agent、教学 Agent、数据分析 Agent 或运维 Agent，真正需要改变的通常不只是模型，还包括：

- 使用哪些工具
- 按什么流程执行
- 哪些操作需要审批
- 需要记住哪些信息
- 如何分配不同模型
- 如何在不同设备上运行

Magi 将这些能力拆分为相对独立的组件，使开发者可以根据任务重新组合，而不需要从头实现会话管理、工具调用、记忆、审批和任务调度。

## 可组合的 Agent Runtime

### Model

Magi 不绑定单一模型。

目前支持：

- OpenAI
- Anthropic
- DeepSeek
- OpenAI 兼容接口
- Anthropic 兼容接口
- 自定义 Endpoint

可以配置不同用途的模型别名：

- `fast`
- `main`
- `deep`

也可以在 TUI 中使用：

```text
/model auto
```

由 Runtime 根据任务类型进行模型路由。

当模型不可用、触发限流或请求失败时，可以根据配置切换到备用 Provider。

### Tool

Tool 提供 Agent 与外部环境交互的基础能力。

Magi 内置 91 个工具，覆盖：

- 文件读写
- Shell
- Git
- 网络搜索
- URL 获取
- 定时任务
- 会话管理
- 记忆检索
- 子智能体
- 多机调度

工具并不会在每次启动时全部加载。

Magi 使用 `ToolSearch` 按需发现和加载工具，以减少上下文占用，并避免固定工具集带来的限制。

开发者也可以接入自己的工具或 MCP Server。

### Skill

Skill 是对任务流程和领域经验的封装。

与单个 Tool 不同，Skill 可以描述：

- 任务应该按什么步骤完成
- 哪些工具应该被调用
- 如何检查结果
- 失败后如何处理
- 什么条件下任务才算完成

Magi 内置的 Skill 包括：

- `verify`
- `debug`
- `stuck`
- `commit-msg`
- `review-pr`

安装其他 Skill：

```bash
magi skill install <github-repository>
```

开发者也可以通过编写 `SKILL.md` 创建自己的工作流。

Skill 可以独立安装、组合和分发，不需要修改 Magi Core。

### Harness

Harness 用于定义 Agent 的运行方式和行为边界。

它可以控制：

- System Prompt
- 工具权限
- 审批规则
- 执行约束
- 任务完成条件
- 失败处理方式
- 不同阶段可使用的能力

同一个 Runtime 可以加载不同 Harness，从而表现为不同类型的 Agent。

例如，Coding Agent、科研 Agent 和教学 Agent 可以共享同一套底层 Runtime，但使用不同的工具、Skill、权限和执行规范。

### Memory

Magi 的 Memory 用于保存跨会话的信息，而不是只依赖当前上下文窗口。

记忆系统包括：

- Durable Memory
- 会话历史
- 上下文召回
- LearningDraft
- 人工审核后持久化

任务完成后，Magi 可以生成 LearningDraft，用于记录：

- 项目约定
- 历史决策
- 错误原因
- 调试过程
- 可复用经验

LearningDraft 不会直接写入长期记忆。用户可以先审核，再决定是否应用。

```bash
magi memory search "<query>"
magi learning list
```

### Planning

Magi 支持将规划与执行分开。

在 Plan Mode 中，Agent 可以先：

1. 分析任务
2. 检索相关文件
3. 明确修改范围
4. 输出实施方案
5. 等待用户批准
6. 开始执行

在方案获批前，Magi 可以阻止高风险编辑和命令执行。

适合：

- 大规模重构
- API 迁移
- 数据库迁移
- 跨模块修改
- 生产环境相关操作

在 TUI 中使用：

```text
/plan
```

### Runtime

Runtime 负责协调以上所有组件。

它处理：

- Agent Loop
- 会话状态
- 流式输出
- 并行工具调用
- 模型路由
- Provider Fallback
- 工具审批
- 子智能体调度
- 多机任务分发
- 状态持久化

开发新的 Agent 时，可以保留 Runtime，只替换 Model、Tool、Skill、Harness 和 Memory 等上层组件。

## 默认形态：终端 Coding Agent

Magi 默认可以直接用于日常编码任务。

### 代码理解与修改

Magi 可以：

- 读取和检索代码仓库
- 修改单个或多个文件
- 跨文件重构
- 更新类型定义
- 修复 Bug
- 编写测试
- 解释陌生代码
- 生成 Commit Message

文件修改通过 `FilePatch` 完成。

补丁会根据精确上下文匹配应用，而不是直接覆盖整个文件。

### 命令执行

Magi 可以执行：

- Shell 命令
- Git 命令
- 测试命令
- 构建命令
- 项目脚本
- 自定义工具

高风险操作可以通过审批机制进行限制。

### 网络搜索与调研

Magi 可以：

- 搜索网络
- 读取网页
- 获取 URL 内容
- 检索代码树
- 查看 Git 历史
- 启动子智能体执行并行调研

### Sessions

Magi 使用 SQLite 保存会话历史。

```bash
magi sessions
magi resume <id>
```

当上下文过长时，可以在 TUI 中使用：

```text
/compact
```

压缩当前上下文，同时保留关键任务状态。

## 多机协同

Magi 可以发现局域网中的其他 Magi 实例，并将任务调度到其他机器。

```bash
magi peers
```

智能体可以指定远程节点：

```json
{
  "target": "peer-name"
}
```

这使同一个任务可以在不同设备上连续执行。

例如：

- 在本地电脑分析代码
- 在构建服务器运行测试
- 在另一台机器执行耗时任务
- 在手机浏览器上审批敏感操作

远程任务与本地工具共享相同的：

- 会话模型
- 权限模型
- 审批机制
- 审计记录

## 手机审批与 Control API

启动后台控制服务：

```bash
magi daemon start
```

配对手机或远程客户端：

```bash
magi pair <name>
```

Control API 可以用于：

- 手机审批工具调用
- 查看任务状态
- 管理后台任务
- 访问当前会话
- 连接远程客户端

在每台机器上启动 Magi Daemon：

```bash
MAGI_CONTROL_BIND=0.0.0.0 magi daemon start
```

配对手机：

```bash
magi pair my-phone
```

随后：

1. 确保手机与运行 Magi 的机器处于同一局域网
2. 打开命令行中显示的 `/panel` 地址
3. 输入 Device ID 和 Token
4. 完成配对

## 可以用 Magi 构建什么

Magi 的默认形态是 Coding Agent，但 Runtime 不限定具体领域。

开发者可以通过替换和组合 Tool、Skill、Harness 与 Memory，构建：

- 科研智能体
- 教学智能体
- 数据分析智能体
- 运维智能体
- 软件测试智能体
- 内部自动化系统
- 领域工作流产品

这些 Agent 可以共享同一套底层能力：

- 会话管理
- 工具调用
- 任务规划
- 权限审批
- 长期记忆
- 多模型路由
- 多机调度

区别主要体现在上层能力组合，而不是重新开发 Runtime。

## 快速开始

### 1. 安装

```bash
git clone https://github.com/EDLee01/magi.git
cd magi

npm install
npm run build
npm link
```

### 2. 配置 API Key

OpenAI：

```bash
export OPENAI_API_KEY="<your-key>"
```

Anthropic：

```bash
export ANTHROPIC_AUTH_TOKEN="<your-key>"
```

DeepSeek：

```bash
export DEEPSEEK_API_KEY="<your-key>"
```

### 3. 初始化

```bash
magi init
```

初始化命令会生成：

```text
~/.magi-next/config.yaml
```

如果尚未设置 API Key，`magi init` 会提示当前 Provider 需要配置的环境变量。

### 4. 启动

```bash
magi
```

执行单次任务：

```bash
magi -p "explain this repo"
```

启动交互式教程：

```bash
magi tutorial
```

教程包含八个简短章节，覆盖模型、文件、记忆、Skill 和多机协同等核心功能。

## 常用命令

| 命令 | 功能 |
|---|---|
| `magi` | 启动交互式 TUI |
| `magi -p "<prompt>"` | 执行单次任务 |
| `magi init` | 配置 Provider 和模型 |
| `magi doctor` | 检查配置路径和运行状态 |
| `magi sessions` | 查看历史会话 |
| `magi resume <id>` | 恢复历史会话 |
| `magi daemon start` | 启动后台 Control API |
| `magi pair <name>` | 配对手机或远程客户端 |
| `magi peers` | 查找局域网中的 Magi 实例 |
| `magi memory search <query>` | 搜索长期记忆 |
| `magi learning list` | 查看 LearningDraft |
| `magi skill install` | 安装 Skill |
| `magi tutorial` | 启动交互式教程 |

TUI 内常用命令：

```text
/help
/model auto
/compact
/plan
```

## 配置示例

配置文件默认位于：

```text
~/.magi-next/config.yaml
```

示例：

```yaml
providers:
  anthropic:
    type: messages-compatible
    format: anthropic-messages
    apiKeyEnv: ANTHROPIC_AUTH_TOKEN
    baseUrl: https://api.anthropic.com

models:
  aliases:
    fast: anthropic:claude-haiku-4-5
    main: anthropic:claude-sonnet-4-6
    deep: anthropic:claude-opus-4-7

  router:
    fast:
      family: claude
      role: haiku
      contextWindow: 200000

    main:
      family: claude
      role: sonnet
      contextWindow: 200000

    deep:
      family: claude
      role: opus
      contextWindow: 200000
```

也可以直接运行：

```bash
magi init
```

由初始化向导生成配置。

## 数据存储位置

```text
~/.magi-next/
  config.yaml
  state/
    sessions.sqlite
    learning-drafts/
  memory/
  skills/
```

具体内容：

```text
~/.magi-next/config.yaml
```

保存 Provider 和模型配置。

```text
~/.magi-next/state/sessions.sqlite
```

保存会话、任务、后台 Job 和审计记录。

```text
~/.magi-next/memory/
```

保存 Durable Memory。

```text
~/.magi-next/skills/
```

保存已安装的 Skill。

```text
~/.magi-next/state/learning-drafts/
```

保存待审核的 LearningDraft。

可以通过以下环境变量修改配置目录：

```bash
export MAGI_CONFIG_DIR=/path/to/custom-directory
```

适用于：

- 沙箱
- 测试环境
- CI
- 多实例部署

## 架构概览

```text
User
  │
  ▼
TUI / CLI / Control API
  │
  ▼
Agent Runtime
  ├── Model Router
  ├── Agent Loop
  ├── Plan Mode
  ├── Session Manager
  ├── Memory
  ├── ToolSearch
  ├── Skill Loader
  ├── Harness
  ├── Approval System
  └── Peer Dispatcher
        │
        ├── Local Tools
        ├── MCP Servers
        ├── Sub-agents
        └── Remote Magi Peers
```

Agent Loop 支持：

- 流式输出
- 并行工具调用
- Provider Fallback
- 子智能体调度
- 工具调用审批
- 会话状态持久化

## 文档

| 文档 | 内容 |
|---|---|
| `ARCHITECTURE.md` | 核心组件、会话、工具和模型路由 |
| `TROUBLESHOOTING.md` | 常见错误与排查方法 |
| `docs/magi-next-learning-loop-v1.html` | Memory 与 Learning Loop 设计 |
| `magi tutorial` | 交互式入门教程 |

## 开发与测试

安装依赖：

```bash
npm install
```

构建：

```bash
npm run build
```

运行测试：

```bash
npm test
```

运行完整验证：

```bash
npm run verify
```

能力评估和回归测试脚本定义在 `package.json` 中，包括：

```text
test:memory-eval
test:patch-eval
report:capability
```

这些脚本用于验证：

- Memory
- FilePatch
- Agent Runtime
- 工具调用
- 能力回归

## 构建要求

- Node.js ≥ 22
- Rust：可选

Rust 用于 Runner Sidecar，为沙箱和 PTY 等能力提供支持。

```bash
npm install
npm run build
npm test
```

## 项目状态

当前版本：

```text
v0.1.13
```

Magi 正在持续开发中。

目前已实现并测试的主要能力包括：

- Agent Loop
- 多模型路由
- Provider Fallback
- MCP
- ToolSearch
- Skills
- Memory
- Learning Loop
- Plan Mode
- Daemon
- 多机任务调度
- 手机控制面板

当前仍处于 Beta 阶段，CLI、配置格式和部分接口可能发生变化。

提交 Bug 时，请附上以下命令的输出：

```bash
magi doctor
magi --version
```

## 开源与扩展

Magi Core 使用 MIT License 开源。

开发者可以基于 Magi：

- 编写新的 Tool
- 编写新的 Skill
- 配置新的 Harness
- 接入新的模型
- 接入 MCP Server
- 构建垂直领域智能体
- 构建内部自动化系统
- 开发独立产品和服务

Magi 的目标不是预设一种固定的 Agent 形态，而是提供一套可以被重新组合的 Runtime。

## License

MIT License
