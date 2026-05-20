---
# ⌨ CLI 入口
> magi-agent 的命令行入口，负责参数解析、快速路径分流、TUI 启动、守护进程模式。

## ⌨ CLI 入口 (entrypoint) `FLOW` — src/entrypoint/main.ts — Bun 启动，commander 解析

### ◆ 快速路径 (Fast Paths) `FLOW` — 不进入 React/Ink 渲染，直接处理后退出

- ◈ **`--version` / `-v`** `FN` — 打印版本号后退出
- ◈ **`doctor`** `FN` — 环境诊断：node 版本、bun 版本、git、API key 可用性、provider 连通性
- ◈ **`serve`** `FN` — 启动 HTTP Control API，监听 127.0.0.1:8765，暴露 /sessions /jobs /agents /approvals /events(SSE)
- ◈ **`config show`** `FN` — 打印解析后的合并配置（去除 secrets）
- ◈ **`config edit`** `FN` — 打开 $EDITOR 编辑 ~/.magi/config.yaml
- ◈ **`migrate`** `FN` — Schema 迁移：v0.8 → v0.9 sessions DB / config 字段
- ◈ **`auth login`** `FN` — OAuth 流：开浏览器 → 回调 → 写入 token 到 keychain
- ◈ **`auth logout`** `FN` — 清除 token
### ◆ 主入口流程 `FLOW` — 没有命中快速路径时进入

- ◈ **加载配置** `FN` — ~/.magi/config.yaml + 项目级 .magi/config.yaml + 环境变量覆盖
- ◈ **解析 CLI flags** `DATA` — `-p/--prompt` headless / `--model` / `--cwd` / `--resume` / `--continue` / `--print` / `--output-format`
- ◈ **初始化 Paths** `FN` — ~/.magi-next/{sessions,memory,plugins,skills,state,logs}
- ◈ **初始化 ProviderRegistry** `FN` — 注册所有 provider preset → 探测 API key
- ◈ **初始化 ToolRegistry** `FN` — 加载内置工具 → 异步 connect MCP servers → 合并工具池
- ◈ **初始化 SessionStore** `FN` — SQLite (sessions.db) 或 JSONL 目录
- ◈ **分支：交互 vs Headless** `FLOW` — 有 -p → headless 单次执行；无 -p → 启动 TUI
### ◆ Headless 模式 `FLOW` — `-p "prompt"` 单次执行

- ◈ **读取 prompt** `FN` — 可来自 -p 参数 / stdin / 文件
- ◈ **创建临时 session** `FN` — in-memory transcript
- ◈ **调用 QueryEngine.submitMessage()** `FN` — 完整 agent 循环
- ◈ **输出格式** `DATA` — `text`(默认) / `json` / `stream-json`
- ◈ **退出码** `DATA` — 0=成功 1=错误 2=interrupted 130=SIGINT
### ◆ TUI 启动流程 `FLOW` — 交互模式

- ◈ **检测 TTY** `FN` — isatty(stdin) && isatty(stdout)，否则降级到 readline
- ◈ **进入 alternate screen** `FN` — ESC[?1049h，保存原终端缓冲
- ◈ **渲染 React App** `FN` — Ink render(<App/>) 启动主循环
- ◈ **注册 cleanup** `FN` — process.on("SIGINT/SIGTERM/exit") → 退出 alternate screen + flush session
### ◆ Daemon / Serve 模式 `FLOW` — 后台 HTTP 控制面

- ◆ **路由表** `DATA` — Bun.serve()
  - ◈ **`POST /sessions`** `FN` — 创建新会话
  - ◈ **`GET /sessions/:id`** `FN` — 获取 transcript
  - ◈ **`POST /sessions/:id/messages`** `FN` — 提交 prompt
  - ◈ **`GET /sessions/:id/events`** `FN` — SSE 流式事件
  - ◈ **`POST /jobs`** `FN` — 后台任务（agent 子进程）
  - ◈ **`GET /jobs/:id`** `FN` — 查询任务状态
  - ◈ **`POST /approvals/:id`** `FN` — 提交审批决定
  - ◈ **`GET /agents`** `FN` — 列出可用 subagent 类型
- ◈ **认证** `DATA` — X-Magi-Token header，token 写入 ~/.magi-next/state/control-token
### ◆ 完整 Slash Command 注册表 (95+) `DATA` — src/commands/ 目录扫描

- ◆ **🟢 会话管理** `TOOL`
  - ◈ **`/clear`** `TOOL` — 清空对话
  - ◈ **`/compact`** `TOOL` — 强制压缩
  - ◈ **`/resume`** `TOOL` — 恢复会话
  - ◈ **`/fork`** `TOOL` — 会话分支
  - ◈ **`/rewind`** `TOOL` — 回退到某条消息
  - ◈ **`/export`** `TOOL` — 导出 session
  - ◈ **`/share`** `TOOL` — 生成可分享链接
  - ◈ **`/exit`** `TOOL` — 退出
  - ◈ **`/session`** `TOOL` — session 管理
  - ◈ **`/summary`** `TOOL` — 会话摘要
  - ◈ **`/thinkback` / `/thinkback-play`** `TOOL` — 思考回放
  - ◈ **`/backfill-sessions`** `TOOL` — 迁移历史 session
- ◆ **🔵 模型与配置** `TOOL`
  - ◈ **`/model`** `TOOL` — 切换模型
  - ◈ **`/effort`** `TOOL` — 调整思考预算
  - ◈ **`/fast`** `TOOL` — 切换 fast mode
  - ◈ **`/config`** `TOOL` — 配置面板
  - ◈ **`/env`** `TOOL` — 环境变量管理
  - ◈ **`/theme`** `TOOL` — 主题
  - ◈ **`/color`** `TOOL` — 配色调试
  - ◈ **`/output-style`** `TOOL` — 输出样式
  - ◈ **`/keybindings`** `TOOL` — 键位查看/编辑
  - ◈ **`/vim`** `TOOL` — vim 输入模式
  - ◈ **`/voice`** `TOOL` — 语音输入
  - ◈ **`/terminalSetup`** `TOOL` — 终端设置
- ◆ **🟣 上下文 / 记忆** `TOOL`
  - ◈ **`/memory`** `TOOL` — 记忆管理
  - ◈ **`/context`** `TOOL` — 上下文检视
  - ◈ **`/ctx_viz`** `TOOL` — 上下文可视化
  - ◈ **`/files`** `TOOL` — 已加载文件列表
  - ◈ **`/add-dir`** `TOOL` — 加入工作目录
  - ◈ **`/copy`** `TOOL` — 复制最近输出
  - ◈ **`/break-cache`** `TOOL` — 清缓存重新加载
  - ◈ **`/force-snip`** `TOOL` — 强制 snip 上下文
- ◆ **🟠 工具/任务** `TOOL`
  - ◈ **`/agents`** `TOOL` — agent 管理
  - ◈ **`/agents-platform`** `TOOL` — agent 平台
  - ◈ **`/tasks`** `TOOL` — 任务列表
  - ◈ **`/skills`** `TOOL` — skills 管理
  - ◈ **`/plugin`** `TOOL` — plugin 管理
  - ◈ **`/reload-plugins`** `TOOL` — 重载 plugin
  - ◈ **`/hooks`** `TOOL` — hook 管理
  - ◈ **`/permissions`** `TOOL` — 权限规则
  - ◈ **`/sandbox-toggle`** `TOOL` — 沙箱开关
  - ◈ **`/mcp`** `TOOL` — MCP server 列表
  - ◈ **`/passes`** `TOOL` — 权限 pass
  - ◈ **`/peers`** `TOOL` — 已连接 peer 列表
  - ◈ **`/buddy`** `TOOL` — 伙伴 agent
  - ◈ **`/teleport`** `TOOL` — teleport 到其他 session
- ◆ **🔴 Plan / Diff / 代码** `TOOL`
  - ◈ **`/plan` / `/ultraplan`** `TOOL` — 进入 plan 模式
  - ◈ **`/diff`** `TOOL` — 查看修改
  - ◈ **`/review`** `TOOL` — PR/代码 review
  - ◈ **`/security-review`** `TOOL` — 安全审查
  - ◈ **`/autofix-pr`** `TOOL` — 自动修 PR comments
  - ◈ **`/branch`** `TOOL` — 分支管理
  - ◈ **`/commit` / `/commit-push-pr`** `TOOL` — 提交流程
  - ◈ **`/issue`** `TOOL` — issue 查看
  - ◈ **`/pr_comments`** `TOOL` — PR comments
  - ◈ **`/subscribe-pr`** `TOOL` — 订阅 PR 活动
  - ◈ **`/perf-issue`** `TOOL` — 性能 issue 报告
  - ◈ **`/torch`** `TOOL` — 焚毁分支
- ◆ **🟡 状态/统计** `TOOL`
  - ◈ **`/status`** `TOOL` — session 状态
  - ◈ **`/stats`** `TOOL` — 统计
  - ◈ **`/cost`** `TOOL` — 本次花费
  - ◈ **`/usage`** `TOOL` — 用量
  - ◈ **`/extra-usage`** `TOOL` — 额外用量
  - ◈ **`/rate-limit-options`** `TOOL` — 速率限制设置
  - ◈ **`/reset-limits`** `TOOL` — 重置限额
  - ◈ **`/mock-limits`** `TOOL` — mock 限额（测试）
  - ◈ **`/release-notes`** `TOOL` — 发版说明
  - ◈ **`/version`** `TOOL` — 版本信息
- ◆ **⚪ 认证/账号** `TOOL`
  - ◈ **`/login` / `/logout`** `TOOL`
  - ◈ **`/oauth-refresh`** `TOOL` — OAuth token 刷新
  - ◈ **`/onboarding`** `TOOL` — 新手引导
  - ◈ **`/install` / `/upgrade`** `TOOL` — 更新 CLI
  - ◈ **`/privacy-settings`** `TOOL` — 隐私设置
  - ◈ **`/feedback`** `TOOL` — 提交反馈
- ◆ **🟤 高级/实验** `TOOL`
  - ◈ **`/bridge` / `/bridge-kick`** `TOOL` — 远程桥接
  - ◈ **`/remoteControlServer`** `TOOL` — 远程控制服务器
  - ◈ **`/remote-env` / `/remote-setup`** `TOOL` — 远程环境
  - ◈ **`/desktop`** `TOOL` — 桌面集成
  - ◈ **`/mobile`** `TOOL` — 移动端
  - ◈ **`/chrome`** `TOOL` — Chrome 扩展
  - ◈ **`/ide`** `TOOL` — IDE 集成
  - ◈ **`/workflows`** `TOOL` — 工作流
  - ◈ **`/desktop`** `TOOL` — 桌面 app
  - ◈ **`/heapdump`** `TOOL` — 堆转储调试
  - ◈ **`/debug-tool-call`** `TOOL` — 工具调用调试
  - ◈ **`/ant-trace`** `TOOL` — 内部 trace（蚂蚁金服遗留命名）
  - ◈ **`/btw`** `TOOL` — by the way 旁注
  - ◈ **`/bughunter`** `TOOL` — bug 猎手
  - ◈ **`/good-claude`** `TOOL` — 点赞当前回复
  - ◈ **`/tag`** `TOOL` — 标签
  - ◈ **`/rename`** `TOOL` — 重命名 session
  - ◈ **`/proactive`** `TOOL` — 主动建议模式
  - ◈ **`/advisor`** `TOOL` — 顾问模式
  - ◈ **`/brief`** `TOOL` — 简报
  - ◈ **`/stickers`** `TOOL` — 贴纸表情
  - ◈ **`/help` / `/doctor`** `TOOL` — 帮助和诊断
### ◆ Ablation Baseline 模式 `DATA` — CLAUDE_CODE_ABLATION_BASELINE 环境变量

- ◈ **强制 CLAUDE_CODE_SIMPLE=1** `STATE` — 关闭简化模式
- ◈ **强制 CLAUDE_CODE_DISABLE_THINKING=1** `STATE` — 禁用 extended thinking
- ◈ **强制 DISABLE_INTERLEAVED_THINKING=1** `STATE` — 禁用交错思考
- ◈ **强制 DISABLE_COMPACT=1** `STATE` — 禁用压缩
- ◈ **强制 DISABLE_AUTO_COMPACT=1** `STATE` — 禁用自动压缩
- ◈ **强制 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1** `STATE` — 禁用自动记忆
- ◈ **强制 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1** `STATE` — 禁用后台任务
### ◆ 其他 Fast Path 入口 `FLOW` — 不进入 React 渲染

- ◈ **`--dump-system-prompt`** `FN` — Ant-only，输出系统提示
- ◈ **`--claude-in-chrome-mcp`** `FN` — Chrome 扩展 MCP server
- ◈ **`--chrome-native-host`** `FN` — Chrome native messaging
- ◈ **`--computer-use-mcp`** `FN` — Computer Use MCP server
- ◈ **`--daemon-worker <kind>`** `FN` — 由 supervisor spawn 的内部 worker
- ◈ **`remote-control / rc / sync / bridge`** `FN` — BRIDGE_MODE 桥接
- ◈ **`daemon`** `FN` — DAEMON 守护进程子命令
- ◈ **`ps / logs / attach / kill`** `FN` — BG_SESSIONS 后台 session 管理
- ◈ **`--bg / --background`** `FN` — 后台模式启动
- ◈ **`new / list / reply`** `FN` — TEMPLATES 模板任务
- ◈ **`environment-runner`** `FN` — BYOC 环境 runner
- ◈ **`self-hosted-runner`** `FN` — 自托管 runner
- ◈ **`--worktree --tmux`** `FN` — 完整 CLI 加载前 exec 进 tmux
- ◈ **`--bare`** `FN` — CLAUDE_CODE_SIMPLE=1 极简模式
---
# ⟳ 核心 Agent 循环
> 系统的心脏。query() 异步生成器实现 prompt → model → tools → loop 状态机，配合 StreamingToolExecutor 实现流式工具执行。

## ⟳ query() 核心循环 `FN` — src/agent/query.ts — AsyncGenerator<SDKMessage>

### ◆ QueryEngine 包装层 `CLASS` — src/agent/queryEngine.ts

- ◆ **状态字段** `DATA` — 类成员变量
  - ◈ **`mutableMessages: Message[]`** `DATA` — 完整对话历史，每轮都会变更
  - ◈ **`totalUsage`** `DATA` — { inputTokens, outputTokens, costUsd } 累加
  - ◈ **`abortController`** `DATA` — AbortController，用于 Ctrl+C 中断
  - ◈ **`currentModel`** `DATA` — 当前模型 ID（可被 /model 切换）
  - ◈ **`permissionContext`** `DATA` — allow/ask/deny 规则 + mode
  - ◈ **`transcriptWriter`** `DATA` — JSONL 持久化写入器
- ◆ **submitMessage(prompt)** `FN` — 主入口，处理一次用户输入
  - ◈ **1. processInput()** `FN` — 解析 slash commands / @mentions / image attachments
  - ◈ **2. buildSystemPrompt()** `FN` — 组装 6 层上下文
  - ◈ **3. selectRelevantMemories()** `FN` — Sonnet 选 ≤5 条相关 memory
  - ◈ **4. for await query() events** `FLOW` — 消费生成器，分发事件
  - ◈ **5. recordToTranscript()** `FN` — 每条消息追加到 JSONL
  - ◈ **6. yield SDKMessage** `FLOW` — 回传给 UI 渲染
- ◈ **interrupt()** `FN` — abortController.abort() — 中断 streaming + 工具执行
- ◈ **fork()** `FN` — 创建 session 副本（用于 /resume 分支）
### ◆ query() 状态机 `FLOW` — 主循环 LOOP 体

- ◆ **步骤 1: 上下文管理** `FLOW` — 每轮开始前检查
  - ◈ **shouldAutoCompact()** `FN` — 检查 token 占用 > window * 0.9
  - ◈ **autoCompact()** `FN` — 调用 microcompact + LLM summarize
  - ◈ **YIELD compact_boundary** `FLOW` — 插入压缩标记，session resume 时识别
- ◆ **步骤 2: 调用模型** `FLOW` — callModel() 流式
  - ◆ **事件类型 (chunk.type)** `DATA` — 从 provider 流出
  - ◈ **`text`** `STATE` — 文本 delta，追加到 assistantBlocks，YIELD text_delta
  - ◈ **`tool_use`** `STATE` — 工具调用 block，pushed 到 toolUseBlocks，置 needsFollowUp=true
  - ◈ **`thinking`** `STATE` — 隐藏思考块（如 Claude extended thinking），UI 可选渲染
  - ◈ **`usage`** `STATE` — { input_tokens, output_tokens, cache_read } 计费
  - ◈ **`stop`** `STATE` — 流结束信号，stop_reason: end_turn / tool_use / max_tokens / stop_sequence
  - ◈ **AbortSignal 检查** `FN` — 每个 chunk 后检查 abortSignal.aborted
  - ◈ **错误捕获** `FN` — CATCH error → if retryable && hasFallback → switchModel + CONTINUE
- ◆ **步骤 3: 构建 assistant message** `FLOW` — content = [...textBlocks, ...toolUseBlocks]
  - ◈ **PUSH 到 mutableMessages** `FN` — 原地变更 messages 数组
  - ◈ **YIELD assistantMessage** `FLOW` — 完整消息回传 UI
- ◆ **步骤 4: 终止判断** `FLOW` — if !needsFollowUp
  - ◈ **withheld_prompt_too_long → reactiveCompact** `STATE` — 紧急压缩重试
  - ◈ **withheld_max_output_tokens → recoveryNudge** `STATE` — "Continue from where you left off" 重试 ≤3 次
  - ◈ **completed → RETURN** `STATE` — 正常退出
- ◆ **步骤 5: 工具执行** `FLOW` — 关键步骤
  - ◆ **权限检查** `FN` — checkToolPermission()
  - ◈ **allow → 直接执行** `STATE`
  - ◈ **deny → 返回 "Permission denied" tool_result(is_error=true)** `STATE`
  - ◈ **ask → YIELD approval_request → 等待 UI 决定** `STATE`
  - ◆ **执行分发** `CLASS` — StreamingToolExecutor
  - ◈ **isConcurrencySafe → Promise.all 并行** `STATE`
  - ◈ **否则串行 await** `STATE`
  - ◈ **pre_tool_use hook 同步执行（exit 2 阻止）** `FN`
  - ◈ **post_tool_use hook 收集 → 注入 system message** `FN`
  - ◆ **tool_result 构建** `DATA`
  - ◈ **`{ type: "tool_result", tool_use_id, content, is_error? }`** `DATA`
  - ◈ **大输出 (>30KB) → persistToFile + preview** `FN`
  - ◈ **CATCH toolError → content=err.msg, is_error=true** `FN`
- ◆ **步骤 6: 追加结果 + CONTINUE** `FLOW` — user message = { role: "user", content: toolResults }
  - ◈ **turnCount++** `FN`
  - ◈ **maxTurns 检查 → YIELD max_turns_reached** `FN`
  - ◈ **GOTO LOOP top** `FLOW`
### ◆ StreamingToolExecutor `CLASS` — 高级：模型还在输出时就开始执行工具

- ◈ **`pendingTools: Queue<ToolCall>`** `DATA`
- ◈ **`completedResults: Map<id, ToolResult>`** `DATA`
- ◈ **addTool(toolCall)** `FN` — enqueue + startExecution（异步启动）
- ◈ **startExecution(toolCall)** `FN` — await executeTool → set 到 completedResults
- ◈ **getCompletedResults()** `FN` — drain Map，按调用顺序返回
- ◈ **abort()** `FN` — 取消所有 pending Promise
### ◆ 状态转换表 `STATE` — 所有可能的退出路径

- ◈ **completed** `STATE` — LLM 返回纯文本，无 tool_use
- ◈ **tool_loop_continue** `STATE` — LLM 返回 tool_use → 执行 → 追加结果
- ◈ **aborted_streaming** `STATE` — 流式过程中收到 abort
- ◈ **aborted_tools** `STATE` — 工具执行前收到 abort
- ◈ **fallback_switched** `STATE` — 可重试错误 → 切换模型重试
- ◈ **compacted_retry** `STATE` — prompt_too_long → 压缩后重试
- ◈ **recovery_nudged** `STATE` — max_output_tokens → 追加恢复提示
- ◈ **max_turns** `STATE` — 达到 maxTurns 上限
- ◈ **fatal_error** `STATE` — 不可重试错误
### ◆ YIELD 事件清单 `DATA` — 所有可能 yield 的事件类型

- ◈ **`request_start`** `DATA` — 请求开始（含 timestamp、messageId）
- ◈ **`compact_boundary`** `DATA` — 压缩点标记
- ◈ **`text_delta`** `DATA` — 增量文本，UI 累加渲染
- ◈ **`tool_use`** `DATA` — 完整工具调用（id, name, input）
- ◈ **`tool_result`** `DATA` — 工具执行结果
- ◈ **`approval_request`** `DATA` — 需要用户审批，等待回传
- ◈ **`usage`** `DATA` — token 计费
- ◈ **`error`** `DATA` — 可恢复或致命错误
- ◈ **`interrupted`** `DATA` — 被 abortSignal 中断
- ◈ **`max_turns_reached`** `DATA` — 达到轮次上限
- ◈ **`result`** `DATA` — 会话结束总结（usage、duration）
---
# 🔧 工具系统
> 60+ 内置工具 + MCP 动态工具。统一的 Tool 接口（Zod schema、permission、并发安全标记），分发器根据 isConcurrencySafe 并行/串行执行。

## 🔧 工具系统 `FLOW` — src/tools/ — 60+ 内置工具 + MCP 动态工具

### ◆ Tool 接口定义 `CLASS` — src/tools/types.ts

- ◈ **`name: string`** `DATA` — 唯一标识，如 "Bash", "FileRead"
- ◈ **`inputSchema: ZodSchema`** `DATA` — 输入校验，运行时验证
- ◈ **`description(input): string`** `FN` — 展示给用户的简短描述
- ◈ **`prompt(): string`** `FN` — 注入到 LLM 的工具文档（详尽）
- ◈ **`call(input, ctx): ToolResult`** `FN` — 执行入口
- ◈ **`checkPermissions(input, ctx)`** `FN` — "allow" | "ask" | "deny" | null
- ◈ **`isReadOnly(input): boolean`** `FN` — 只读 → 自动允许
- ◈ **`isDestructive(input): boolean`** `FN` — 不可逆 → 强制审批
- ◈ **`isConcurrencySafe(input): boolean`** `FN` — 可并行（FileRead/Grep yes，Bash/FileEdit no）
- ◈ **`renderResult(result)`** `FN` — TUI 自定义渲染（可选）
- ◈ **`isEnabled()`** `FN` — feature flag（如 ExperimentalAgent）
### ◆ 内置工具清单 (60+) `FLOW` — 按类别分组，源自 src/tools/ 目录扫描

- ◆ **📂 文件系统** `TOOL` — 6 个核心工具
  - ◆ **Read (FileReadTool)** `TOOL` — 读文件，支持文本/PDF/图片/notebook
  - ◈ **`file_path: string`** `DATA` — 绝对路径
  - ◈ **`offset?: number`** `DATA` — 行偏移（0-based）
  - ◈ **`limit?: number`** `DATA` — 最多读取行数
  - ◈ **`pages?: string`** `DATA` — PDF 页范围 "1-5"
  - ◆ **Write (FileWriteTool)** `TOOL` — 创建/覆写文件
  - ◈ **`file_path: string`** `DATA`
  - ◈ **`content: string`** `DATA` — 完整文件内容
  - ◆ **Edit (FileEditTool)** `TOOL` — 字符串替换
  - ◈ **`file_path: string`** `DATA`
  - ◈ **`old_string: string`** `DATA` — 待替换文本
  - ◈ **`new_string: string`** `DATA` — 替换为
  - ◈ **`replace_all?: boolean`** `DATA` — 默认 false
  - ◆ **Glob (GlobTool)** `TOOL` — 文件名 glob，按 mtime 排序
  - ◈ **`pattern: string`** `DATA` — 如 **/*.ts
  - ◈ **`path?: string`** `DATA` — 默认 cwd
  - ◆ **Grep (GrepTool)** `TOOL` — ripgrep 包装
  - ◈ **`pattern: string`** `DATA` — 正则
  - ◈ **`path?: string`** `DATA`
  - ◈ **`glob?: string`** `DATA` — 文件 glob 过滤
  - ◈ **`type?: string`** `DATA` — js/py/rust 等
  - ◈ **`output_mode`** `DATA` — content/files_with_matches/count
  - ◈ **`-A/-B/-C`** `DATA` — 上下文行数
  - ◈ **`context`** `DATA` — 上下行 alias
  - ◈ **`-n`** `DATA` — 行号（默认 true）
  - ◈ **`-i`** `DATA` — 大小写不敏感
  - ◈ **`head_limit`** `DATA` — 默认 250，0=无限
  - ◈ **`offset`** `DATA` — 跳过前 N 项
  - ◈ **`multiline`** `DATA` — 跨行匹配
  - ◆ **NotebookEdit (NotebookEditTool)** `TOOL` — Jupyter cell 编辑
  - ◈ **`notebook_path: string`** `DATA`
  - ◈ **`cell_id?: string`** `DATA` — 插入时的锚点 cell
  - ◈ **`new_source: string`** `DATA`
  - ◈ **`cell_type?`** `DATA` — code/markdown
  - ◈ **`edit_mode?`** `DATA` — replace/insert/delete
- ◆ **⚙️ Shell 执行** `TOOL` — 3 个工具
  - ◆ **Bash (BashTool)** `TOOL` — 通用 shell
  - ◈ **`command: string`** `DATA`
  - ◈ **`timeout?: number`** `DATA` — ms
  - ◈ **`description?: string`** `DATA` — 3-5 字描述
  - ◈ **`run_in_background?`** `DATA` — 后台执行
  - ◈ **`dangerouslyDisableSandbox?`** `DATA` — 关闭沙箱（危险）
  - ◈ **`_simulatedSedEdit?`** `DATA` — 内部 sed 替代
  - ◈ **PowerShell (PowerShellTool)** `TOOL` — Windows PS 执行
  - ◆ **REPL (REPLTool)** `TOOL` — 交互式 REPL session
  - ◈ **可访问: Read/Write/Edit/Glob/Grep/Bash/NotebookEdit/Agent** `STATE`
  - ◆ **BashOutput / KillShell** `TOOL` — 后台 shell 控制
  - ◈ **`shell_id: string`** `DATA`
  - ◈ **BashOutput: 轮询读输出** `FN`
  - ◈ **KillShell: 终止 shell** `FN`
- ◆ **🤖 Agent / 任务** `TOOL` — 12+ 个工具
  - ◆ **Agent (AgentTool, 别名 Task)** `TOOL` — 启动子 agent
  - ◈ **`description: string`** `DATA` — 3-5 字
  - ◈ **`prompt: string`** `DATA` — 完整任务说明
  - ◈ **`subagent_type?`** `DATA` — general-purpose/Explore/Plan/...
  - ◈ **`model?`** `DATA` — sonnet/opus/haiku
  - ◈ **`run_in_background?`** `DATA`
  - ◈ **`name?`** `DATA` — SendMessage 可寻址名称
  - ◈ **`team_name?`** `DATA` — 团队上下文
  - ◈ **`isolation?`** `DATA` — worktree | remote
  - ◈ **`cwd?`** `DATA` — 工作目录覆盖
  - ◆ **SendMessage (SendMessageTool)** `TOOL` — 给已运行 agent 发消息
  - ◈ **`to: string`** `DATA` — name / "*" / uds:<sock> / bridge:<id>
  - ◈ **`summary?`** `DATA` — 5-10 字预览
  - ◈ **`message`** `DATA` — string 或 StructuredMessage
  - ◈ **TaskCreate** `TOOL` — subject, description, blockedBy?, metadata?
  - ◈ **TaskGet** `TOOL` — taskId
  - ◈ **TaskList** `TOOL` — 无参数
  - ◈ **TaskUpdate** `TOOL` — taskId, status?, subject?, description?, owner?, blocks?, blockedBy?, metadata?
  - ◈ **TaskOutput** `TOOL` — 内部结构化输出
  - ◈ **TaskStop** `TOOL` — task_id (停止后台任务)
  - ◈ **TeamCreate** `TOOL` — team_name, description?, agent_type?
  - ◈ **TeamDelete** `TOOL` — 无参数（删除当前团队）
- ◆ **🌐 Web 工具** `TOOL` — 3 个工具
  - ◆ **WebFetch (WebFetchTool)** `TOOL`
  - ◈ **`url: string`** `DATA` — 完整有效 URL
  - ◈ **`prompt: string`** `DATA` — 提取指令
  - ◆ **WebSearch (WebSearchTool)** `TOOL`
  - ◈ **`query: string`** `DATA` — 至少 2 字符
  - ◈ **`allowed_domains?`** `DATA`
  - ◈ **`blocked_domains?`** `DATA`
  - ◈ **默认区域** `DATA` — 面向中国大陆，默认 zh-CN / CN，结果大陆优先但可由配置覆盖
  - ◈ **WebBrowserTool** `TOOL` — Ant 内部 stub（feature-gated）
- ◆ **🔌 MCP 工具** `TOOL` — 4 个 + 动态注册
  - ◈ **mcp (MCPTool)** `TOOL` — 万能入口，passthrough 到 MCP server
  - ◈ **McpAuth (McpAuthTool)** `TOOL` — 动态命名 mcp__<server>__authenticate
  - ◈ **ListMcpResourcesTool** `TOOL` — server? 过滤
  - ◈ **ReadMcpResourceTool** `TOOL` — server, uri
  - ◈ **动态命名空间** `STATE` — `mcp__{server}__{tool}`
- ◆ **📋 Plan / Worktree** `TOOL` — 4 个工具
  - ◈ **EnterPlanMode** `TOOL` — 无参数
  - ◆ **ExitPlanMode (V2)** `TOOL`
  - ◈ **`allowedPrompts?`** `DATA` — Array<{ tool: "Bash", prompt: string }>
  - ◈ **`plan?`** `DATA` — 计划文本（SDK schema）
  - ◈ **`planFilePath?`** `DATA` — 计划文件路径
  - ◆ **EnterWorktree** `TOOL`
  - ◈ **`name?`** `DATA` — 字母/数字/./_/-，max 64
  - ◆ **ExitWorktree** `TOOL`
  - ◈ **`action: keep | remove`** `DATA`
  - ◈ **`discard_changes?`** `DATA` — remove + 有未提交时必须 true
- ◆ **💾 Skill / Memory / Config** `TOOL` — 4 个工具
  - ◆ **Skill (SkillTool)** `TOOL`
  - ◈ **`skill: string`** `DATA` — 如 commit / review-pr
  - ◈ **`args?: string`** `DATA`
  - ◆ **Config (ConfigTool)** `TOOL`
  - ◈ **`setting: string`** `DATA` — theme/model 等 key
  - ◈ **`value?`** `DATA` — string/boolean/number，省略=读
  - ◆ **TodoWrite (TodoWriteTool)** `TOOL` — 替换式 todo 列表
  - ◈ **`todos: TodoList`** `DATA` — 完整新列表
  - ◆ **ToolSearch (ToolSearchTool)** `TOOL` — 按需发现工具
  - ◈ **`query: string`** `DATA` — 或 select:<tool_name>
  - ◈ **`max_results?`** `DATA` — 默认 5
- ◆ **⏰ 调度** `TOOL` — 4 个 Cron 工具
  - ◆ **CronCreate (ScheduleCronTool)** `TOOL`
  - ◈ **`cron: string`** `DATA` — 5 字段本地时间
  - ◈ **`prompt: string`** `DATA` — 触发时入队的提示
  - ◈ **`recurring?`** `DATA` — 默认 true
  - ◈ **`durable?`** `DATA` — 持久化到 .claude/scheduled_tasks.json
  - ◈ **CronUpdate** `TOOL` — 更新已存在 cron job
  - ◈ **CronDelete** `TOOL` — id
  - ◈ **CronList** `TOOL` — 列出全部
- ◆ **💬 通知 / 沟通** `TOOL` — 2 个工具
  - ◆ **SendUserMessage (BriefTool, 别名 Brief)** `TOOL`
  - ◈ **`message: string`** `DATA` — markdown
  - ◈ **`attachments?: string[]`** `DATA`
  - ◈ **`status: normal | proactive`** `DATA`
  - ◆ **AskUserQuestion (AskUserQuestionTool)** `TOOL`
  - ◈ **`questions: Array<Question>`** `DATA` — 1-4 个
  - ◈ **Question.question/header/options** `DATA` — 2-4 options
  - ◈ **Option: { label, description, preview? }** `DATA`
  - ◈ **multiSelect?** `DATA` — 多选
- ◆ **🔍 LSP** `TOOL`
  - ◆ **LSP (LSPTool)** `TOOL` — LSP 协议代理
  - ◈ **goToDefinition** `STATE`
  - ◈ **findReferences** `STATE`
  - ◈ **hover** `STATE`
  - ◈ **documentSymbol** `STATE`
  - ◈ **workspaceSymbol** `STATE`
  - ◈ **goToImplementation** `STATE`
  - ◈ **prepareCallHierarchy** `STATE`
  - ◈ **incomingCalls / outgoingCalls** `STATE`
  - ◈ **`filePath, line (1-based), character (1-based)`** `DATA`
- ◆ **🚀 Remote / 协调** `TOOL`
  - ◆ **RemoteTrigger (RemoteTriggerTool)** `TOOL`
  - ◈ **`action: list/get/create/update/run`** `DATA`
  - ◈ **`trigger_id?`** `DATA` — get/update/run 必填
  - ◈ **`body?`** `DATA` — JSON for create/update
  - ◈ **StructuredOutput (SyntheticOutputTool)** `TOOL` — 内部 coordinator
  - ◈ **workflow (WorkflowTool)** `TOOL` — Ant 内部 stub
- ◆ **🟫 Ant 内部 Stubs** `DATA` — feature-gated，外部构建为 no-op
  - ◈ **SleepTool** `STATE` — 暂停执行
  - ◈ **MonitorTool** `STATE`
  - ◈ **ListPeersTool** `STATE`
  - ◈ **PushNotificationTool** `STATE`
  - ◈ **SnipTool** `STATE` — 上下文截断
  - ◈ **TerminalCaptureTool** `STATE`
  - ◈ **ReviewArtifactTool** `STATE`
  - ◈ **VerifyPlanExecutionTool** `STATE`
  - ◈ **CtxInspectTool** `STATE`
  - ◈ **DiscoverSkillsTool** `STATE`
  - ◈ **SuggestBackgroundPRTool** `STATE`
  - ◈ **SubscribePRTool** `STATE`
  - ◈ **SendUserFileTool** `STATE`
  - ◈ **TungstenTool (tungsten)** `STATE` — Ant 内部
### ◆ 权限系统 `FLOW` — 4 层决策

- ◆ **层 1: Tool 自验证** `FN` — tool.validateInput()
  - ◈ **Zod schema 验证** `FN`
  - ◈ **失败 → deny** `STATE`
- ◆ **层 2: Tool 自定义检查** `FN` — tool.checkPermissions()
  - ◈ **Bash: 危险命令模式 → deny** `STATE`
  - ◈ **FileWrite: 检查目标路径白名单** `STATE`
  - ◈ **WebFetch: 检查 URL 白名单** `STATE`
- ◆ **层 3: 全局规则** `DATA` — settings.yaml permissions.{allow,ask,deny}
  - ◈ **`"Bash(git status)"`** `DATA` — 具体子命令
  - ◈ **`"Bash(npm:*)"`** `DATA` — npm 任意子命令（前缀+冒号）
  - ◈ **`"FileRead(*)"`** `DATA` — 所有文件
  - ◈ **`"FileWrite(/etc/*)"`** `DATA` — glob 路径
  - ◈ **匹配优先级: deny > ask > allow** `STATE`
- ◆ **层 4: 权限模式默认** `DATA` — context.mode
  - ◈ **`default`** `STATE` — 只读 allow，写操作 ask
  - ◈ **`acceptEdits`** `STATE` — 所有 allow（自动批准编辑）
  - ◈ **`bypassPermissions`** `STATE` — 完全跳过审批（危险）
  - ◈ **`plan`** `STATE` — 只读模式，禁止所有写操作
### ◆ Bash 工具深度 `TOOL` — 最复杂的工具

- ◆ **执行管线** `FLOW`
  - ◈ **1. dangerous 检测** `FN` — rm -rf, sudo, mkfs, dd of=, chmod 777, curl|bash, > /dev/sd*
  - ◈ **2. cwd 解析** `FN` — 默认 session cwd，可被 ctx 覆盖
  - ◈ **3. 环境变量** `FN` — 继承父进程 + MAGI_* 注入
  - ◈ **4. spawn(bash, [-lc, command])** `FN` — login shell 加载 .bashrc
  - ◈ **5. 流式 stdout/stderr** `FN` — 边执行边返回（streaming output）
  - ◈ **6. timeout 杀进程** `FN` — SIGTERM → 5s → SIGKILL
  - ◈ **7. 大输出处理** `FN` — > 30KB → write 到 ~/.magi-next/state/bash-output/{id}
- ◆ **Background 模式** `FLOW` — run_in_background: true
  - ◈ **spawnBackgroundTask** `FN` — 注册到 backgroundShells Map
  - ◈ **shellId 返回** `STATE` — BashOutput / KillShell 用此 ID
  - ◈ **输出 tail 文件** `STATE` — ~/.magi-next/state/shells/{id}.out
### ◆ FileEdit 工具深度 `TOOL` — 最常用的写工具

- ◈ **old_string 唯一性** `FN` — countOccurrences > 1 → 报错（除非 replace_all）
- ◈ **old_string 不存在** `FN` — 直接报错，不模糊匹配
- ◈ **空白敏感** `FN` — 保留 indentation，行号前缀（Read tool 输出）会被剥离
- ◈ **Diff 生成** `FN` — createUnifiedDiff(file, before, after)
- ◈ **审批 UI** `FN` — 触发 DiffApproval overlay（y/n/d）
- ◈ **原子写入** `FN` — write to .tmp → rename
- ◈ **行尾保留** `FN` — CRLF/LF 检测保留原样
### ◆ Agent 工具深度 `TOOL` — 启动子 agent

- ◆ **subagent_type** `DATA` — 内置 + 用户定义
  - ◈ **general-purpose** `STATE` — 默认，所有工具
  - ◈ **Explore** `STATE` — 只读探索，禁止 Edit/Write
  - ◈ **Plan** `STATE` — 设计实施方案
  - ◈ **verification** `STATE` — 验证实现正确性
  - ◈ **magi-guide** `STATE` — 回答 Magi 使用问题
  - ◈ **statusline-setup** `STATE` — 配置状态栏
- ◆ **隔离模式** `DATA` — isolation 参数
  - ◈ **默认（无隔离）** `STATE` — 继承当前 cwd
  - ◈ **`worktree`** `STATE` — git worktree add 临时分支
  - ◈ **cleanup** `STATE` — agent 无修改 → 自动删除 worktree
- ◆ **运行模式** `DATA`
  - ◈ **前台（默认）** `STATE` — 阻塞等待结果
  - ◈ **`run_in_background: true`** `STATE` — 返回 agentId，task notification 通知完成
### ◆ 并发执行调度 `FLOW` — executeTools(toolCalls)

- ◈ **分组** `FN` — concurrent = isConcurrencySafe()，sequential = otherwise
- ◈ **Promise.all 并行** `FN` — concurrent.map(executeSingle)
- ◈ **串行 await** `FN` — for sequential in order
- ◈ **结果按调用顺序合并** `FN` — 保持 toolUseBlocks 顺序
### ◆ 工具结果处理 `FLOW` — formatToolResult(result, maxChars=30000)

- ◈ **小于 30KB → 直接返回** `STATE`
- ◈ **大于 30KB → persistToFile + preview(2000)** `STATE`
- ◈ **错误结果 → is_error: true** `STATE`
- ◈ **图片结果 → content[].type = image** `STATE`
---
# 🌐 Provider 路由
> Preset 化的多 provider 适配 + Anthropic/OpenAI 格式互转 Proxy + 智能路由（任务分类 + 模型评分 + Fallback 链）。

## 🌐 Provider 路由系统 `FLOW` — src/provider/ — Preset + Proxy + ModelRouter

### ◆ ProviderPreset 接口 `CLASS` — src/provider/presets.ts

- ◈ **`id: string`** `DATA` — "official"/"deepseek"/"kimi"/"lmstudio"/"openrouter"
- ◈ **`name: string`** `DATA` — 显示名
- ◈ **`baseUrl: string`** `DATA` — API endpoint
- ◈ **`apiFormat`** `DATA` — "anthropic" | "openai_chat" | "openai_responses" | "bedrock" | "vertex"
- ◈ **`defaultModels`** `DATA` — { main, haiku, sonnet, opus } 别名→具体模型
- ◈ **`authStrategy`** `DATA` — "api_key" | "auth_token" | "dual_same_token" | "oauth"
- ◈ **`modelContextWindows`** `DATA` — Record<modelId, tokens>
- ◈ **`needsApiKey: boolean`** `DATA` — lmstudio 等本地服务可不需要
### ◆ 内置 Preset 列表 `DATA` — PRESET_REGISTRY

- ◈ **official** `DATA` — Anthropic 官方 (api.anthropic.com)，apiFormat=anthropic
- ◈ **aws-bedrock** `DATA` — AWS Bedrock，IAM 认证，特殊 sigv4 签名
- ◈ **gcp-vertex** `DATA` — Google Vertex AI，GCP token 认证
- ◈ **deepseek** `DATA` — api.deepseek.com，apiFormat=openai_chat
- ◈ **kimi** `DATA` — Moonshot Kimi，apiFormat=openai_chat
- ◈ **siliconflow** `DATA` — 硅基流动聚合，apiFormat=openai_chat
- ◈ **openrouter** `DATA` — OpenRouter 聚合，apiFormat=openai_chat
- ◈ **hotaitool** `DATA` — 内部代理，gpt-5.5/claude-opus，apiFormat=openai_chat
- ◈ **lmstudio** `DATA` — 本地 LM Studio，localhost:1234，无 key
- ◈ **ollama** `DATA` — 本地 Ollama，localhost:11434
### ◆ 模型选择优先级 `FLOW` — resolveModel(context)

- ◈ **1. context.sessionOverride** `STATE` — /model 命令运行时切换
- ◈ **2. context.startupFlag** `STATE` — `--model` CLI 参数
- ◈ **3. env.MAGI_MODEL** `STATE` — 环境变量
- ◈ **4. config.models.aliases.main** `STATE` — YAML 配置
- ◈ **5. DEFAULT_MODEL** `STATE` — 硬编码默认值
### ◆ Fallback 链 `FLOW` — resolveFallbackChain(config, alias)

- ◆ **配置示例** `DATA` — YAML
  - ◈ **`aliases.main: "anthropic/claude-sonnet-4-6"`** `DATA`
  - ◈ **`fallbacks.main: [openai/gpt-4o, deepseek/deepseek-chat]`** `DATA`
- ◈ **parseModelSpec(spec)** `FN` — "provider/model" → { providerName, model }
- ◈ **返回 [primary, ...fallbacks]** `FN` — 按顺序尝试
### ◆ 路由执行 `FLOW` — routeProviderRequest(input)

- ◈ **FOR EACH candidate** `FLOW` — 从 fallback 链取下一个
- ◈ **adapter = registry.get(candidate.provider)** `FN`
- ◆ **TRY: adapter.complete()** `FN`
  - ◈ **成功 → 记录 attempts，返回** `STATE`
  - ◈ **失败 → classifyProviderError** `FN`
  - ◈ **可重试 → CONTINUE 下一个** `STATE`
  - ◈ **不可重试 → THROW** `STATE`
- ◈ **全部失败 → THROW "All candidates exhausted"** `STATE`
### ◆ 智能路由 (ModelRouter) `CLASS` — 可选：根据 prompt 自动选模型

- ◆ **classifyTask(prompt)** `FN` — 任务分类
  - ◈ **`quick`** `STATE` — prompt.length < 280
  - ◈ **`coding`** `STATE` — 含 "function/fix/bug/refactor/implement"
  - ◈ **`reasoning`** `STATE` — 含 "analyze/explain/why/think"
  - ◈ **`vision`** `STATE` — 附带图片
  - ◈ **`long_context`** `STATE` — estimateTokens > 50000
  - ◈ **`review`** `STATE` — 含 "review/check/audit"
- ◆ **scoreCandidate(model, taskKind)** `FN` — 加权评分
  - ◈ **official: +8 / local: +6** `DATA`
  - ◈ **coding × claude: +28 / × deepseek: +24** `DATA`
  - ◈ **reasoning × deepseek: +30 / × claude: +22** `DATA`
  - ◈ **quick × haiku: +18** `DATA`
  - ◈ **context_window 1M+: +24 / 250K+: +16 / 128K+: +8** `DATA`
  - ◈ **vision × supportsVision: +20** `DATA`
### ◆ API 格式转换 (Proxy) `FLOW` — 关键：Anthropic IR ↔ OpenAI Chat

- ◆ **anthropicToOpenaiChat(request)** `FN` — 请求方向
  - ◈ **system → messages[0]={role:system}** `STATE`
  - ◈ **tool_use blocks → tool_calls[]** `STATE`
  - ◈ **tool_result → role=tool, tool_call_id** `STATE`
  - ◈ **tools → [{ type: function, function: {name, parameters} }]** `STATE`
  - ◈ **image content → multimodal content array** `STATE`
- ◆ **openaiChatToAnthropic(response)** `FN` — 响应方向
  - ◈ **choices[0].message.content → text block** `STATE`
  - ◈ **tool_calls[] → tool_use blocks** `STATE`
  - ◈ **JSON.parse(arguments) → input** `STATE`
  - ◈ **usage.prompt_tokens → input_tokens** `STATE`
- ◆ **openaiStreamToAnthropic(SSE)** `FN` — 流式转换状态机
  - ◈ **state.messageStartSent** `STATE` — 只发一次 message_start
  - ◈ **state.currentBlockIndex** `STATE` — 当前 content block 索引
  - ◈ **state.toolArgBuffers: Map<index, string>** `STATE` — 累积 tool args 文本
  - ◈ **delta.content → content_block_delta(text_delta)** `STATE`
  - ◈ **delta.tool_calls → content_block_start(tool_use) + input_json_delta** `STATE`
  - ◈ **[DONE] → message_stop** `STATE`
### ◆ 错误分类 `DATA` — classifyProviderError(status, body)

- ◈ **401/403 → auth, not retryable** `STATE`
- ◈ **402 → billing, not retryable** `STATE`
- ◈ **429 → rate_limit, retryable, parse Retry-After** `STATE`
- ◈ **404 → model_not_found, not retryable** `STATE`
- ◈ **413 → context_overflow, shouldCompress=true** `STATE`
- ◈ **408 → timeout, retryable** `STATE`
- ◈ **500-503 → server_error/overloaded, retryable** `STATE`
- ◈ **Body 含 "prompt is too long" → withheld_prompt_too_long** `STATE`
- ◈ **Body 含 "max_tokens" → withheld_max_output_tokens** `STATE`
### ◆ 认证策略 `FLOW` — authStrategy 实现

- ◈ **api_key → x-api-key header** `STATE`
- ◈ **auth_token → Authorization: Bearer {token}** `STATE`
- ◈ **dual_same_token → 同一个 token，两种 header 都发** `STATE`
- ◈ **oauth → token from keychain，自动刷新** `STATE`
- ◈ **aws-sigv4 → AWS 签名 v4，IAM credentials** `STATE`
---
# 🧠 记忆与上下文
> 6 层上下文构建（系统/项目/记忆/动态/Git/日期）+ Sonnet 选记忆 + microcompact + LLM summarize 两阶段压缩。

## 🧠 记忆与上下文管理 `FLOW` — src/memory/ + src/context/

### ◆ 记忆存储位置 `DATA` — 文件层级

- ◈ **`~/.magi-next/memory.md`** `DATA` — 全局用户记忆索引
- ◈ **`~/.magi-next/memory/{name}.md`** `DATA` — 单条记忆文件，frontmatter + body
- ◈ **`~/.magi-next/state/project-memory/{base64url(cwd)}.md`** `DATA` — 项目级记忆
- ◈ **`{cwd}/AGENTS.md` / CLAUDE.md** `DATA` — 项目规则文件
- ◈ **`{cwd}/.magi/rules/*.md`** `DATA` — 额外规则文件（递归读取）
### ◆ 记忆类型 `DATA` — frontmatter type 字段

- ◈ **user** `STATE` — 用户角色、偏好、知识背景
- ◈ **feedback** `STATE` — 工作方式指导（纠正 + 确认），含 Why/How to apply
- ◈ **project** `STATE` — 项目上下文、截止日期、事件，含 Why/How
- ◈ **reference** `STATE` — 外部系统指针（Linear/Grafana/文档链接）
### ◆ MemoryEntry 结构 `DATA` — YAML frontmatter + markdown body

- ◈ **`name: string`** `DATA` — 记忆名
- ◈ **`description: string`** `DATA` — 一行描述，用于相关性判断（critical）
- ◈ **`type: MemoryType`** `DATA` — 4 种之一
- ◈ **body: markdown** `DATA` — 正文
### ◆ 记忆相关性选择 `FN` — selectRelevantMemories() 每轮动态

- ◈ **收集所有记忆 manifest** `FN` — 只用 frontmatter，不读 body
- ◈ **调用快速模型 (Sonnet/Haiku)** `FN` — prompt: "选出最相关的 ≤5 条"
- ◈ **parse 返回的文件名列表** `FN` — Sonnet 返回 JSON array
- ◈ **loadMemoryFile() 读取 body** `FN` — 只对选中的读取
- ◈ **注入到 system prompt 的 Layer 4** `STATE`
### ◆ 上下文 6 层构建 `FLOW` — buildFullContext()

- ◈ **L1: 系统指令** `STATE` — 核心行为规则（identity/safety/tone）
- ◈ **L2: 项目规则** `STATE` — AGENTS.md / CLAUDE.md
- ◈ **L3: 用户记忆索引** `STATE` — MEMORY.md（≤200 行）
- ◈ **L4: 动态记忆** `STATE` — 本轮选中的 ≤5 条 memory body
- ◈ **L5: Git 上下文** `STATE` — branch + status + recent commits
- ◈ **L6: 当前日期** `STATE` — today() ISO
### ◆ 上下文预算 `DATA` — computeContextBudget()

- ◈ **MODEL_CONTEXT_WINDOW = 200000** `DATA` — 默认 200K tokens
- ◈ **RESERVED_OUTPUT = 8192** `DATA` — 预留输出空间
- ◈ **MAX_COMPACT_OUTPUT = 20000** `DATA` — 压缩摘要上限
- ◈ **POST_COMPACT_FILE_BUDGET = 50000** `DATA` — 压缩后文件恢复预算
- ◈ **POST_COMPACT_SKILL_BUDGET = 25000** `DATA` — 压缩后 skill 恢复
- ◈ **shouldCompact = used > available * 0.9** `STATE` — 触发条件
### ◆ 上下文压缩 (Compaction) `FLOW` — 两阶段

- ◆ **Stage 1: Microcompact** `FN` — 轻量级 token 削减，无 LLM 调用
  - ◈ **移除重复的工具结果** `STATE`
  - ◈ **截断超长工具输出（保留前 N + 后 N）** `STATE`
  - ◈ **合并连续的系统消息** `STATE`
  - ◈ **丢弃 thinking blocks（已使用过的）** `STATE`
- ◆ **Stage 2: LLM Summarize** `FN` — 用 Haiku 总结
  - ◈ **prompt: "Summarize... preserving Key decisions / Files / Pending tasks / Important context"** `DATA`
  - ◈ **maxOutputTokens = 20000** `DATA`
  - ◈ **替换 messages 为 [summary_user, ack_assistant]** `STATE`
- ◆ **Stage 3: Post-compact 恢复** `FN` — 关键文件重新注入
  - ◈ **extractRecentFiles(messages, limit=5)** `FN` — 识别最近读过的文件
  - ◈ **按预算追加到 summary 后** `FN`
  - ◈ **类似的 skill 内容也恢复** `FN`
### ◆ Reactive Compact `FLOW` — 紧急压缩

- ◈ **触发：prompt_too_long error** `STATE`
- ◈ **messages.length < 4 → 无法压缩，throw** `STATE`
- ◈ **复用 autoCompact 流程** `STATE`
- ◈ **重试调用模型，最多 2 次** `STATE`
### ◆ 记忆写入 `FN` — saveMemory()

- ◈ **生成文件名** `FN` — 由 type + slug(name)
- ◈ **写 frontmatter + body** `FN`
- ◈ **更新 MEMORY.md 索引** `FN` — 追加 - [name](file.md) — desc
- ◈ **审计记录** `FN` — recordAudit({ action: memory.append })
---
# 💾 会话/Hooks/Skills/Plugins
> JSONL 会话持久化 + 9 种 Hook 事件 × 4 种 Hook 类型 + Skill 系统 + Plugin marketplace。

## 💾 会话/Hooks/Skills/Plugins 系统 `FLOW` — src/session/ + src/hooks/ + src/skills/ + src/plugins/

### ◆ 会话存储 `FLOW` — JSONL 或 SQLite

- ◆ **存储格式** `DATA` — 每行一条 SessionEntry
  - ◈ **`type`** `DATA` — user/assistant/system/tool_result/compact_boundary
  - ◈ **`uuid: string`** `DATA` — 消息唯一 ID
  - ◈ **`parentUuid: string|null`** `DATA` — 消息链，支持分支
  - ◈ **`timestamp: ISO string`** `DATA`
  - ◈ **`content: MessageContent`** `DATA` — text/tool_use/tool_result blocks
  - ◈ **`metadata?`** `DATA` — model, usage, cost, sessionId
- ◆ **存储位置** `DATA`
  - ◈ **Legacy: `~/.magi/projects/{base64url(cwd)}/{sessionId}.jsonl`** `DATA`
  - ◈ **magi-next: `~/.magi-next/state/sessions.db` (SQLite)** `DATA`
  - ◈ **Schema: sessions(id, cwd, created_at), messages(...)** `DATA`
- ◆ **会话恢复 resumeSession()** `FN`
  - ◈ **loadSessionEntries(sessionId)** `FN` — 读取所有行
  - ◈ **findLast(compact_boundary)** `FN` — 找最后一个压缩点
  - ◈ **只加载 boundary 之后的消息** `FN` — compact 之前已被压缩到 summary
  - ◈ **reconstructChain()** `FN` — 按 parentUuid 重建消息链（支持分支）
- ◆ **会话索引** `DATA` — 加速 /sessions 列表
  - ◈ **索引字段: id, title, lastMessage, mtime, cwd** `DATA`
  - ◈ **title: 自动生成（首条 user 消息前 50 字符）** `STATE`
  - ◈ **搜索: tantivy 或 SQLite FTS5** `DATA`
### ◆ Hooks 系统 `FLOW` — 事件 × 类型 矩阵

- ◆ **HookEvent (26 种)** `DATA` — 完整事件列表 — coreSchemas.ts
  - ◆ **工具相关 (3)** `DATA`
  - ◈ **`PreToolUse`** `STATE` — tool_name, tool_input, tool_use_id — 可阻止
  - ◈ **`PostToolUse`** `STATE` — tool_name, tool_input, tool_response, tool_use_id
  - ◈ **`PostToolUseFailure`** `STATE` — tool_name, tool_input, tool_use_id, error, is_interrupt?
  - ◆ **会话生命周期 (5)** `DATA`
  - ◈ **`SessionStart`** `STATE` — source: startup/resume/clear/compact, agent_type?, model?
  - ◈ **`SessionEnd`** `STATE` — base only
  - ◈ **`UserPromptSubmit`** `STATE` — prompt — 用户提交时（可改写）
  - ◈ **`Stop`** `STATE` — stop_hook_active, last_assistant_message?
  - ◈ **`StopFailure`** `STATE` — error, error_details?, last_assistant_message?
  - ◆ **Subagent (2)** `DATA`
  - ◈ **`SubagentStart`** `STATE` — agent_id, agent_type
  - ◈ **`SubagentStop`** `STATE` — agent_id, agent_transcript_path, agent_type
  - ◆ **压缩 (2)** `DATA`
  - ◈ **`PreCompact`** `STATE` — trigger: manual/auto, custom_instructions
  - ◈ **`PostCompact`** `STATE` — trigger: manual/auto, compact_summary
  - ◆ **权限 (2)** `DATA`
  - ◈ **`PermissionRequest`** `STATE` — tool_name, tool_input, permission_suggestions?
  - ◈ **`PermissionDenied`** `STATE` — tool_name, tool_input, tool_use_id, reason
  - ◆ **团队 (3)** `DATA`
  - ◈ **`TeammateIdle`** `STATE` — teammate_name, team_name
  - ◈ **`TaskCreated`** `STATE` — task_id, task_subject, task_description?, teammate_name?
  - ◈ **`TaskCompleted`** `STATE` — task_id, task_subject, ...
  - ◆ **MCP Elicitation (2)** `DATA` — MCP server 请求用户输入
  - ◈ **`Elicitation`** `STATE` — mcp_server_name, message, mode?, url?, elicitation_id?, requested_schema?
  - ◈ **`ElicitationResult`** `STATE` — action: accept/decline/cancel, content?
  - ◆ **配置/文件 (5)** `DATA`
  - ◈ **`ConfigChange`** `STATE` — source: user/project/local/policy/skills, file_path?
  - ◈ **`WorktreeCreate`** `STATE` — name
  - ◈ **`WorktreeRemove`** `STATE` — worktree_path
  - ◈ **`InstructionsLoaded`** `STATE` — CLAUDE.md 加载: file_path, memory_type, load_reason
  - ◈ **`CwdChanged`** `STATE` — old_cwd, new_cwd
  - ◈ **`FileChanged`** `STATE` — file_path, event: change/add/unlink
  - ◆ **其他 (2)** `DATA`
  - ◈ **`Notification`** `STATE` — message, title?, notification_type
  - ◈ **`Setup`** `STATE` — trigger: init/maintenance
  - ◆ **Base 字段（所有事件）** `DATA`
  - ◈ **`session_id: string`** `DATA`
  - ◈ **`transcript_path: string`** `DATA`
  - ◈ **`cwd: string`** `DATA`
  - ◈ **`permission_mode?`** `DATA`
  - ◈ **`agent_id?`** `DATA` — 仅子 agent 上下文
  - ◈ **`agent_type?`** `DATA` — 子 agent 或 --agent
- ◆ **HookType (4 种)** `DATA`
  - ◆ **command (BashCommandHook)** `STATE` — 执行 shell
  - ◈ **`command: string`** `DATA`
  - ◈ **`if?: string`** `DATA` — 权限规则过滤，如 "Bash(git *)"
  - ◈ **`shell?`** `DATA` — bash | powershell（默认 bash）
  - ◈ **`timeout?`** `DATA` — seconds
  - ◈ **`statusMessage?`** `DATA` — spinner 文本
  - ◈ **`once?`** `DATA` — 一次后移除
  - ◈ **`async?`** `DATA` — 后台非阻塞
  - ◈ **`asyncRewake?`** `DATA` — 后台 + exit 2 唤醒模型
  - ◈ **env.ARGUMENTS = JSON.stringify(context)** `STATE`
  - ◈ **exit 0=ok / 2=block / 其他=warn** `STATE`
  - ◆ **prompt (PromptHook)** `STATE` — 调用 LLM
  - ◈ **`prompt: string`** `DATA` — 使用 $ARGUMENTS 注入 context
  - ◈ **`if?`** `DATA`
  - ◈ **`timeout?`** `DATA`
  - ◈ **`model?`** `DATA` — 默认 small fast model
  - ◈ **`statusMessage?`** `DATA`
  - ◈ **`once?`** `DATA`
  - ◆ **http (HttpHook)** `STATE` — POST 到 URL
  - ◈ **`url: string`** `DATA`
  - ◈ **`headers?`** `DATA` — 支持 $VAR_NAME 插值
  - ◈ **`allowedEnvVars?: string[]`** `DATA` — 显式插值白名单
  - ◈ **`if? / timeout? / statusMessage? / once?`** `DATA`
  - ◆ **agent (AgentHook)** `STATE` — 启动验证 agent
  - ◈ **`prompt: string`** `DATA` — $ARGUMENTS 注入
  - ◈ **`timeout?`** `DATA` — 默认 60s
  - ◈ **`model?`** `DATA` — 默认 Haiku
  - ◈ **`if? / statusMessage? / once?`** `DATA`
  - ◆ **Hook Matcher 结构** `DATA` — settings.json 中
  - ◈ **`matcher: string`** `DATA` — 工具名、|分隔列表、空=匹配全部
  - ◈ **`hooks: HookCommand[]`** `DATA` — 同 matcher 下多个 hook
- ◆ **HookDefinition 字段** `DATA`
  - ◈ **`event`** `DATA` — 触发事件
  - ◈ **`type`** `DATA` — 执行类型
  - ◈ **`if?`** `DATA` — 条件匹配，如 "Bash(git push *)"
  - ◈ **`timeout?`** `DATA` — 超时 ms
  - ◈ **`once?`** `DATA` — 只执行一次
  - ◈ **`blocking?`** `DATA` — pre_* 是否同步阻塞
- ◆ **执行流程 executeHooks()** `FN`
  - ◈ **config.hooks.filter(event)** `FN`
  - ◈ **matchesCondition(hook.if, ctx)** `FN`
  - ◈ **switch hook.type 分发** `FN`
  - ◈ **collect HookResult[]** `FN`
  - ◈ **pre_*: exit 2 抛出 BlockedByHook** `FN`
  - ◈ **post_*: stdout 注入对话** `FN`
### ◆ Skills 系统 `FLOW` — 可复用的 prompt + 工具白名单

- ◆ **Bundled Skills (16 个)** `DATA` — initBundledSkills() 启动注册
  - ◈ **update-config** `TOOL` — 配置 Magi (settings.json/hooks/permissions/env)
  - ◈ **simplify** `TOOL` — 审查代码：reuse / quality / efficiency
  - ◈ **verify** `TOOL` — 验证改动：跑 tests/typecheck
  - ◈ **debug** `TOOL` — 调试 session，读 debug log
  - ◈ **remember** `TOOL` — 审视 auto-memory，提升到 CLAUDE.md
  - ◈ **batch** `TOOL` — 大规模并行改动，spawn 5-30 worktree agents 各开 PR
  - ◈ **stuck** `TOOL` — Ant-only 诊断卡死 session
  - ◈ **skillify** `TOOL` — 生成 skill 模板
  - ◈ **keybindings-help** `TOOL` — 快捷键参考
  - ◈ **loop** `TOOL` — 循环 agent 任务（AGENT_TRIGGERS gated）
  - ◈ **schedule** `TOOL` — 调度远程 agent（AGENT_TRIGGERS_REMOTE gated）
  - ◈ **claude-api** `TOOL` — Claude API 集成（BUILDING_CLAUDE_APPS gated）
  - ◈ **claude-in-chrome** `TOOL` — Chrome 扩展集成
  - ◈ **dream** `TOOL` — Ant-only Dream（KAIROS gated）
  - ◈ **hunter** `TOOL` — artifact review (REVIEW_ARTIFACT gated)
  - ◈ **lorem-ipsum** `TOOL` — 占位文本生成（dev/test）
- ◆ **BundledSkillDefinition 字段** `DATA`
  - ◈ **`name: string`** `DATA`
  - ◈ **`description: string`** `DATA`
  - ◈ **`aliases?: string[]`** `DATA`
  - ◈ **`whenToUse?: string`** `DATA`
  - ◈ **`argumentHint?: string`** `DATA`
  - ◈ **`allowedTools?: string[]`** `DATA` — 工具白名单
  - ◈ **`model?: string`** `DATA`
  - ◈ **`disableModelInvocation?`** `DATA` — 不让模型自动调
  - ◈ **`userInvocable?`** `DATA` — 允许用户 / 调用
  - ◈ **`isEnabled?: () => boolean`** `DATA`
  - ◈ **`hooks?: HooksSettings`** `DATA` — skill 内联 hooks
  - ◈ **`context?: inline | fork`** `DATA` — 内联 vs fork 子 session
  - ◈ **`agent?: string`** `DATA` — 指定运行的 agent 类型
  - ◈ **`files?: Record<string, string>`** `DATA` — 附加参考文件落盘
  - ◈ **`getPromptForCommand(args, ctx)`** `FN` — 动态构建 prompt
- ◆ **Skill 发现** `FN` — listSkills()
  - ◈ **Bundled (代码内注册)** `DATA`
  - ◈ **`~/.magi-next/skills/*.md`** `DATA` — 全局
  - ◈ **`{cwd}/.magi/skills/*.md`** `DATA` — 项目级
  - ◈ **Plugin 提供的 skills** `DATA` — manifest.skills 注入
- ◆ **Skill 调用** `FN` — invokeSkill(name, args)
  - ◈ **$ARGUMENTS 替换 args** `FN`
  - ◈ **若 allowedTools → 过滤工具池** `FN`
  - ◈ **若 model → 临时切换** `FN`
  - ◈ **context=inline → 同 session 展开** `FN`
  - ◈ **context=fork → spawn 子 session** `FN`
### ◆ Plugins 系统 `FLOW` — 打包发布的扩展

- ◆ **PluginManifest** `DATA` — plugin.json
  - ◈ **name, version, description** `DATA`
  - ◈ **`skills?: SkillDefinition[]`** `DATA`
  - ◈ **`hooks?: HookDefinition[]`** `DATA`
  - ◈ **`mcpServers?: McpServerConfig[]`** `DATA`
  - ◈ **`tools?: ToolModule[]`** `DATA` — 动态加载的 ts/js 模块
- ◆ **Plugin 加载** `FN`
  - ◈ **glob ~/.magi-next/plugins/*/plugin.json** `FN`
  - ◈ **isPluginEnabled(name)** `FN` — 从 config.plugins 读
  - ◈ **注入 skills/hooks/mcp 到全局注册表** `FN`
- ◆ **Plugin Marketplace** `DATA` — 发现源
  - ◈ **HTTP marketplace url** `DATA` — JSON 索引
  - ◈ **local marketplace-*.json** `DATA` — plugins 目录扫描
  - ◈ **autoUpdate: 定期拉取新版本** `DATA`
### ◆ 配置文件 `DATA` — ~/.magi-next/config.yaml

- ◈ **`version: "0.1"`** `DATA`
- ◈ **`control.bind / port`** `DATA` — HTTP API 监听
- ◈ **`providers`** `DATA` — preset 配置 + 覆盖
- ◈ **`models.aliases / fallbacks`** `DATA`
- ◈ **`permissions.allow / ask / deny`** `DATA`
- ◈ **`hooks: HookDefinition[]`** `DATA`
- ◈ **`mcp.servers`** `DATA` — MCP server 注册
- ◈ **`skills` / `plugins`** `DATA` — 启用列表
- ◈ **`memory.enabled / autoSelect`** `DATA`
- ◈ **`ui.theme / fullscreen / vim`** `DATA`
---
# 🔌 MCP 客户端
> 4 种传输（stdio/SSE/HTTP/WebSocket），工具/资源发现，审批流程（never/always/dangerous），连接生命周期管理。

## 🔌 MCP 客户端 `FLOW` — src/mcp/ — Model Context Protocol

### ◆ 传输层 (8 种) `FLOW` — McpTransport — 完整 schema 列表

- ◆ **stdio** `STATE` — 本地子进程（最常用）
  - ◈ **`command: string`** `DATA`
  - ◈ **`args: string[]`** `DATA`
  - ◈ **`env?: Record<string,string>`** `DATA`
  - ◈ **StdioTransport over JSON-RPC newline-delimited** `STATE`
  - ◈ **process.on(exit) → 自动清理** `FN`
- ◆ **sse** `STATE` — HTTP Server-Sent Events
  - ◈ **`url: string`** `DATA`
  - ◈ **`headers?`** `DATA`
  - ◈ **`headersHelper?`** `DATA` — 动态 headers 函数
  - ◈ **`oauth?`** `DATA` — OAuth 配置
- ◆ **sse-ide** `STATE` — IDE 模式 SSE
  - ◈ **`url: string`** `DATA`
  - ◈ **`ideName: string`** `DATA` — VSCode/JetBrains/...
  - ◈ **`ideRunningInWindows?`** `DATA` — IDE 运行在 Windows（路径处理）
- ◆ **ws** `STATE` — WebSocket
  - ◈ **`url: string`** `DATA` — ws:// 或 wss://
  - ◈ **`headers?`** `DATA`
  - ◈ **`headersHelper?`** `DATA`
- ◆ **ws-ide** `STATE` — IDE 模式 WebSocket
  - ◈ **`url: string`** `DATA`
  - ◈ **`ideName: string`** `DATA`
  - ◈ **`authToken?`** `DATA`
  - ◈ **`ideRunningInWindows?`** `DATA`
- ◆ **http (Streamable)** `STATE` — MCP 2024-11 新协议
  - ◈ **`url: string`** `DATA`
  - ◈ **`headers?`** `DATA`
  - ◈ **`oauth?`** `DATA`
  - ◈ **X-MCP-Session-Id 维持会话** `STATE`
- ◆ **sdk** `STATE` — 进程内 SDK server
  - ◈ **`name: string`** `DATA`
  - ◈ **InProcessTransport — 无网络/进程** `STATE`
- ◆ **claudeai-proxy** `STATE` — 通过 claude.ai 代理
  - ◈ **`url: string`** `DATA`
  - ◈ **`id: string`** `DATA` — 代理标识
### ◆ Config Scope (7 种) `DATA` — 配置作用域，决定可见性 + 优先级

- ◈ **`local`** `STATE` — 当前 cwd .claude/
- ◈ **`user`** `STATE` — ~/.claude/
- ◈ **`project`** `STATE` — .claude/ 提交到 git
- ◈ **`dynamic`** `STATE` — 动态注入
- ◈ **`enterprise`** `STATE` — 企业策略
- ◈ **`claudeai`** `STATE` — claude.ai 同步
- ◈ **`managed`** `STATE` — MDM 管理
### ◆ OAuth Config (McpOAuthConfigSchema) `DATA`

- ◈ **`clientId?`** `DATA`
- ◈ **`callbackPort?`** `DATA`
- ◈ **`authServerMetadataUrl?`** `DATA` — 必须 https
- ◈ **`xaa?`** `DATA` — Cross-App Access (XAA / SEP-990)
### ◆ 连接状态 `DATA`

- ◆ **ConnectedMCPServer** `STATE` — type: "connected"
  - ◈ **client** `DATA`
  - ◈ **capabilities** `DATA`
  - ◈ **serverInfo?** `DATA`
  - ◈ **instructions?** `DATA`
  - ◈ **config** `DATA`
  - ◈ **cleanup()** `FN`
- ◈ **FailedMCPServer** `STATE` — type: "failed", error?, config
- ◈ **PendingMCPServer** `STATE` — type: "pending"
### ◆ 初始化握手 `FLOW` — McpClient.initialize()

- ◈ **`initialize` request** `FN` — 声明 capabilities
- ◈ **`protocolVersion: "2024-11-05"`** `DATA`
- ◈ **`capabilities: { tools, resources, prompts, sampling }`** `DATA`
- ◈ **`clientInfo: { name, version }`** `DATA`
- ◈ **server 返回 serverInfo + capabilities** `FN`
- ◈ **`initialized` notification** `FN` — 握手完成
### ◆ 工具发现 `FN` — discoverMcpTools()

- ◈ **request("tools/list", {})** `FN`
- ◈ **命名空间** `STATE` — name = "mcp__" + serverName + "__" + tool.name
- ◈ **truncate description** `STATE` — 上限 2048 chars
- ◈ **inputSchema** `STATE` — 直接转发到 LLM tool definition
- ◈ **注入到全局工具池** `STATE`
### ◆ 工具执行 `FN` — executeMcpTool()

- ◈ **request("tools/call", { name, arguments })** `FN`
- ◆ **响应处理** `FN`
  - ◈ **content[].type=text → 拼接** `STATE`
  - ◈ **content[].type=image → base64 注入** `STATE`
  - ◈ **content[].type=resource → embedded resource** `STATE`
  - ◈ **isError → 标记 tool_result.is_error** `STATE`
- ◆ **错误码** `DATA` — JSON-RPC error
  - ◈ **`-32001` Session expired → reconnect 重试** `STATE`
  - ◈ **`-32042` Needs retry (auth) → MCP auth required** `STATE`
  - ◈ **`-32603` Internal error → 直接报错** `STATE`
### ◆ 审批流程 `FLOW` — checkMcpApproval()

- ◈ **`approval: never`** `STATE` — 永不询问
- ◈ **`approval: always`** `STATE` — 总是询问
- ◈ **`approval: dangerous` (默认)** `STATE` — 只对危险操作询问
- ◈ **isMcpToolDangerous()** `FN` — 名字含 write/delete/execute/run/modify
### ◆ MCP 资源 `FLOW` — 类似文件的资源暴露

- ◈ **resources/list → uri[]** `FN`
- ◈ **resources/read(uri) → text** `FN`
- ◈ **resources/subscribe(uri)** `FN` — 订阅变更（websocket）
- ◈ **resources/templates/list** `FN` — URI 模板（含参数）
### ◆ MCP Prompts `FLOW` — 服务器侧 prompt 模板

- ◈ **prompts/list** `FN`
- ◈ **prompts/get(name, args) → messages[]** `FN`
- ◈ **可被 slash command 调用** `STATE`
### ◆ MCP Sampling `FLOW` — 服务器请求 client 调 LLM

- ◈ **server → client: createMessage 请求** `FN`
- ◈ **client 调用本地 LLM provider** `FN`
- ◈ **回传 message 给 server** `FN`
- ◈ **需要用户审批** `STATE`
### ◆ McpConnectionManager `CLASS` — 生命周期

- ◈ **connections: Map<serverName, McpConnection>** `DATA`
- ◈ **connect(name, config)** `FN` — 懒加载，已存在直接复用
- ◈ **process.on(exit) → 清理 + 自动重连** `FN`
- ◈ **disconnectAll()** `FN` — session_end 触发
- ◈ **getTools()** `FN` — 聚合所有 server 的工具
---
# 🖥 TUI 系统
> React + Ink 全屏 TUI，覆盖层系统（Diff/Approval/Picker），流式渲染，键盘快捷键，Slash Command。

## 🖥 TUI 系统 `FLOW` — src/tui/ — React + Ink 全屏渲染

### ◆ 渲染栈 `DATA` — 技术选型

- ◈ **React (custom fork)** `STATE` — 基于 React 18+
- ◈ **Ink (custom fork)** `STATE` — React renderer for terminal
- ◈ **Yoga layout** `STATE` — Flexbox 布局引擎
- ◈ **ANSI escape codes** `STATE` — 颜色 + 光标控制
- ◈ **alternate screen buffer** `STATE` — ESC[?1049h，退出后恢复
### ◆ 主组件树 `CLASS` — <App/> 根组件

- ◆ **Top-level Screens** `CLASS` — src/screens/
  - ◈ **REPL.tsx (896KB)** `CLASS` — 主交互界面
  - ◈ **Doctor.tsx (73KB)** `CLASS` — 诊断界面
  - ◈ **ResumeConversation.tsx (59KB)** `CLASS` — Session 恢复界面
- ◆ **<App>** `CLASS` — 顶层容器
  - ◆ **Layout / 状态** `CLASS`
  - ◈ **FullscreenLayout.tsx (84KB)** `CLASS` — 全屏布局
  - ◈ **VirtualMessageList.tsx (148KB)** `CLASS` — 虚拟滚动消息列表
  - ◈ **StatusLine.tsx (49KB)** `CLASS` — 底部状态栏
  - ◈ **Stats.tsx (152KB)** `CLASS` — 统计/用量展示
  - ◆ **消息渲染** `CLASS`
  - ◈ **<UserMessage>** `CLASS`
  - ◈ **<AssistantMessage>** `CLASS` — 含 streaming
  - ◈ **<ToolUseBlock>** `CLASS`
  - ◈ **<ToolResultBlock>** `CLASS` — 折叠/展开
  - ◈ **<MarkdownRenderer>** `CLASS`
  - ◈ **<CodeBlock>** `CLASS` — 语法高亮
  - ◈ **<DiffBlock>** `CLASS`
  - ◈ **StructuredDiff.tsx (25KB)** `CLASS`
  - ◈ **FileEditToolDiff.tsx (21KB)** `CLASS`
  - ◈ **ContextVisualization.tsx (76KB)** `CLASS`
  - ◆ **输入** `CLASS`
  - ◈ **TextInput.tsx (20KB)** `CLASS`
  - ◈ **BaseTextInput.tsx (19KB)** `CLASS`
  - ◈ **VimTextInput.tsx (16KB)** `CLASS` — vim 模式输入
  - ◆ **Dialogs / Overlays** `CLASS`
  - ◈ **BridgeDialog.tsx (34KB)** `CLASS` — 远程控制桥接
  - ◈ **BypassPermissionsModeDialog** `CLASS` — 跳过权限提示
  - ◈ **AutoModeOptInDialog (13KB)** `CLASS`
  - ◈ **CostThresholdDialog** `CLASS` — 花费阈值警示
  - ◈ **ExportDialog (19KB)** `CLASS` — 导出对话
  - ◈ **WorktreeExitDialog (35KB)** `CLASS`
  - ◈ **TrustDialog/** `CLASS` — 信任 / 权限对话
  - ◈ **ResumeTask (38KB)** `CLASS`
  - ◈ **QuickOpenDialog (28KB)** `CLASS` — 快速打开文件
  - ◈ **RemoteEnvironmentDialog (38KB)** `CLASS`
  - ◈ **ThemePicker (35KB)** `CLASS`
  - ◈ **ConsoleOAuthFlow (79KB)** `CLASS` — OAuth 流程
  - ◆ **Agent / 协调** `CLASS`
  - ◈ **CoordinatorAgentStatus (36KB)** `CLASS` — 协调 agent 状态
  - ◈ **AgentProgressLine (14KB)** `CLASS` — agent 进度条
  - ◈ **TaskListV2 (50KB)** `CLASS` — 任务列表
  - ◈ **agents/AgentsList (52KB)** `CLASS`
  - ◈ **agents/AgentsMenu (70KB)** `CLASS`
  - ◈ **agents/AgentDetail (23KB)** `CLASS`
  - ◈ **agents/AgentEditor (26KB)** `CLASS`
  - ◆ **通知 Hooks (17 个)** `CLASS` — hooks/notifs/
  - ◈ **useAntOrgWarningNotification** `FN`
  - ◈ **useAutoModeUnavailableNotification** `FN`
  - ◈ **useCanSwitchToExistingSubscription** `FN`
  - ◈ **useDeprecationWarningNotification** `FN`
  - ◈ **useFastModeNotification** `FN`
  - ◈ **useIDEStatusIndicator** `FN`
  - ◈ **useInstallMessages** `FN`
  - ◈ **useLspInitializationNotification** `FN`
  - ◈ **useMcpConnectivityStatus** `FN`
  - ◈ **useModelMigrationNotifications** `FN`
  - ◈ **useNpmDeprecationNotification** `FN`
  - ◈ **usePluginAutoupdateNotification** `FN`
  - ◈ **usePluginInstallationStatus** `FN`
  - ◈ **useRateLimitWarningNotification** `FN`
  - ◈ **useSettingsErrors** `FN`
  - ◈ **useStartupNotification** `FN`
  - ◈ **useTeammateShutdownNotification** `FN`
  - ◆ **Pickers / Suggesters** `CLASS`
  - ◈ **<SessionPicker>** `CLASS`
  - ◈ **<ModelPicker>** `CLASS`
  - ◈ **<SlashCommandSuggester>** `CLASS`
  - ◈ **<FileMentionSuggester>** `CLASS`
  - ◈ **<HelpOverlay>** `CLASS`
  - ◈ **<MemoryViewer>** `CLASS`
  - ◈ **<TaskListOverlay>** `CLASS`
  - ◈ **<AskUserQuestion>** `CLASS` — 工具触发的提问
### ◆ 输入处理 `FLOW` — useInput hook

- ◆ **特殊键** `DATA`
  - ◈ **`Enter`** `STATE` — 提交 prompt（多行模式 Shift+Enter）
  - ◈ **`Ctrl+C`** `STATE` — running 时中断；否则退出
  - ◈ **`Ctrl+D`** `STATE` — 空输入时退出
  - ◈ **`Ctrl+L`** `STATE` — 清屏（保留对话）
  - ◈ **`Ctrl+R`** `STATE` — 搜索历史
  - ◈ **`Up/Down`** `STATE` — history 浏览
  - ◈ **`Ctrl+Up/Down`** `STATE` — transcript 滚动
  - ◈ **`PageUp/Down`** `STATE` — transcript 翻页
  - ◈ **`Tab`** `STATE` — 自动补全
  - ◈ **`Escape`** `STATE` — 关闭 overlay
  - ◈ **`Ctrl+Z`** `STATE` — 挂起到后台（fg 恢复）
  - ◈ **`Shift+Tab`** `STATE` — 切换 plan/normal mode
- ◆ **前缀触发** `DATA`
  - ◈ **`/`** `STATE` — slash command
  - ◈ **`@`** `STATE` — @ 文件引用（fuzzy search）
  - ◈ **`!`** `STATE` — !command 直接执行 shell
  - ◈ **`#`** `STATE` — #memory 添加记忆
### ◆ 流式输出渲染 `FLOW` — renderStreamingResponse()

- ◆ **事件分发** `FN`
  - ◈ **text_delta → buffer += text → reconcile** `STATE`
  - ◈ **tool_use_start → showToolSpinner** `STATE`
  - ◈ **tool_result → hideSpinner + renderResult** `STATE`
  - ◈ **usage → updateStatusBar(tokens)** `STATE`
  - ◈ **error → renderErrorBlock** `STATE`
  - ◈ **approval_request → showOverlay** `STATE`
- ◆ **Markdown 增量渲染** `FN`
  - ◈ **micromark 流式解析** `STATE`
  - ◈ **代码块: 检测 ``` 语言标识** `STATE`
  - ◈ **链接渲染: OSC 8 escape** `STATE`
  - ◈ **部分块未完成 → 显示 cursor** `STATE`
### ◆ Diff 审批 UI `FLOW` — <DiffApprovalOverlay>

- ◈ **parseDiff(unifiedDiff) → hunks[]** `FN`
- ◆ **renderDiffHunks** `FN`
  - ◈ **+ 行: 绿色背景** `STATE`
  - ◈ **- 行: 红色背景** `STATE`
  - ◈ **context: dim** `STATE`
  - ◈ **@@ header: dim italic** `STATE`
- ◆ **操作键** `DATA`
  - ◈ **`y` / `Enter`** `STATE` — 批准
  - ◈ **`n` / `Escape`** `STATE` — 拒绝
  - ◈ **`d`** `STATE` — 展开完整 diff
  - ◈ **`e`** `STATE` — 编辑后再审批
  - ◈ **`a`** `STATE` — 本会话全自动批准
### ◆ 工具执行显示 `FLOW` — Tool spinner + result

- ◆ **Spinner** `FN`
  - ◈ **frames: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏** `DATA` — braille 旋转
  - ◈ **interval: 80ms** `DATA`
  - ◈ **描述: tool.description(input)** `STATE`
- ◆ **工具结果定制渲染** `FN`
  - ◈ **Bash: $ command + stdout 截断 500** `STATE`
  - ◈ **FileRead: "Read X (N lines)"** `STATE`
  - ◈ **FileEdit: "Wrote X" + compact diff** `STATE`
  - ◈ **Grep: "Search: P → N files"** `STATE`
  - ◈ **WebFetch: title + summary** `STATE`
### ◆ Slash Command 系统 `DATA` — SLASH_COMMANDS 注册表

- ◈ **`/help`** `TOOL` — 显示命令
- ◈ **`/model [alias]`** `TOOL` — 切换模型
- ◈ **`/status`** `TOOL` — session 状态
- ◈ **`/memory`** `TOOL` — 查看记忆
- ◈ **`/sessions`** `TOOL` — session 列表
- ◈ **`/resume [id|query]`** `TOOL` — 恢复 session
- ◈ **`/continue`** `TOOL` — 继续最近 session
- ◈ **`/compact`** `TOOL` — 强制压缩
- ◈ **`/clear`** `TOOL` — 清空对话
- ◈ **`/diff`** `TOOL` — 查看当前修改
- ◈ **`/exit`** `TOOL` — 退出
- ◈ **`/cost`** `TOOL` — 本 session 花费
- ◈ **`/cwd`** `TOOL` — 切换工作目录
- ◈ **`/permissions`** `TOOL` — 查看权限规则
- ◈ **`/hooks`** `TOOL` — 管理 hooks
- ◈ **`/mcp`** `TOOL` — MCP server 列表
- ◈ **`/skills`** `TOOL` — skills 列表
- ◈ **`/tasks`** `TOOL` — task 列表
- ◈ **`/agents`** `TOOL` — 后台 agent 列表
- ◈ **`/fast`** `TOOL` — 切换 fast mode
- ◈ **`/vim`** `TOOL` — 切换 vim 输入模式
- ◈ **`/init`** `TOOL` — 生成 AGENTS.md
- ◈ **`/{skill_name}`** `TOOL` — 调用用户 skill
### ◆ 主题/外观 `DATA` — theme.ts

- ◈ **dark (默认)** `STATE`
- ◈ **light** `STATE`
- ◈ **high-contrast** `STATE`
- ◈ **自定义颜色覆盖（YAML）** `STATE`
---
# 🤖 子 Agent 系统
> AgentTool 启动子 agent，支持 worktree 隔离 / 远程会话 / 后台运行；Coordinator 模式调度多 worker；XML task-notification 协议。

## 🤖 子 Agent 系统 `FLOW` — src/agents/ — Coordinator + Worker

### ◆ AgentTool 入口 `TOOL` — 工具被调用 → 启动子 agent

- ◆ **参数** `DATA`
  - ◈ **`description: string`** `DATA` — 3-5 字短描述
  - ◈ **`prompt: string`** `DATA` — 完整任务说明
  - ◈ **`subagent_type?`** `DATA` — 类型选择
  - ◈ **`model?`** `DATA` — "sonnet" | "opus" | "haiku" 覆盖
  - ◈ **`run_in_background?`** `DATA` — 后台运行
  - ◈ **`isolation?`** `DATA` — "worktree" 隔离
### ◆ Subagent 类型 `DATA` — AgentDefinition[]

- ◆ **general-purpose** `STATE` — 通用，可访问所有工具
  - ◈ **默认 model: 继承父** `DATA`
  - ◈ **工具集: 全部** `DATA`
  - ◈ **场景: 复杂多步任务** `DATA`
- ◆ **Explore** `STATE` — 快速探索代码库（只读）
  - ◈ **tools - Edit/Write/NotebookEdit** `DATA`
  - ◈ **thoroughness: quick/medium/very thorough** `DATA`
  - ◈ **场景: 找文件、搜代码、回答代码库问题** `DATA`
- ◆ **Plan** `STATE` — 设计实施方案
  - ◈ **tools - Edit/Write/NotebookEdit** `DATA`
  - ◈ **产出: 步骤计划 + 关键文件 + 权衡分析** `DATA`
- ◆ **verification** `STATE` — 验证实现正确性
  - ◈ **运行 build/test/lint** `DATA`
  - ◈ **产出: PASS/FAIL/PARTIAL + 证据** `DATA`
- ◆ **magi-guide** `STATE` — 回答 Magi/Claude API 使用问题
  - ◈ **tools: Glob/Grep/Read/WebFetch/WebSearch** `DATA`
- ◈ **statusline-setup** `STATE` — 配置状态栏（专用 prompt）
- ◈ **用户自定义** `STATE` — ~/.magi-next/agents/*.md
### ◆ AgentDefinition 文件格式 `DATA` — ~/.magi-next/agents/{name}.md

- ◈ **frontmatter.name** `DATA`
- ◈ **frontmatter.description** `DATA`
- ◈ **frontmatter.model? (sonnet/opus/haiku)** `DATA`
- ◈ **frontmatter.allowedTools? (string[])** `DATA`
- ◈ **frontmatter.disallowedTools? (string[])** `DATA`
- ◈ **body: system prompt** `DATA`
### ◆ 执行模式 `FLOW` — runSubagentQuery()

- ◆ **前台同步** `STATE` — 默认
  - ◈ **父阻塞 await** `STATE`
  - ◈ **parentMessages = []** `STATE` — 不继承父对话
  - ◈ **工具调用: 父进程同上下文** `STATE`
  - ◈ **完成后返回 result.text 给父** `STATE`
- ◆ **后台异步** `STATE` — run_in_background: true
  - ◈ **registerBackgroundTask** `FN`
  - ◈ **生成 agentId 立即返回** `STATE`
  - ◈ **spawn 独立进程** `FN`
  - ◈ **输出文件: tasks/{agentId}.output** `DATA`
  - ◈ **完成 → task-notification XML 注入父** `FN`
  - ◈ **SendMessage 工具续接** `FN`
- ◆ **Worktree 隔离** `STATE` — isolation: worktree
  - ◈ **git worktree add .claude/worktrees/{name}** `FN`
  - ◈ **新分支 from HEAD** `FN`
  - ◈ **子 agent cwd = worktree path** `FN`
  - ◈ **完成: 无修改 → 自动 remove** `FN`
  - ◈ **完成: 有修改 → 返回 worktree path + branch** `FN`
### ◆ Coordinator 模式 `FLOW` — 编排器调度多 worker

- ◈ **Coordinator 是特殊 agent** `STATE` — 通常 model=opus
- ◆ **工作流** `FN`
  - ◈ **1. TaskCreate 拆分任务** `STATE`
  - ◈ **2. AgentTool spawn workers (并行)** `STATE`
  - ◈ **3. workers 用 TaskUpdate 更新状态** `STATE`
  - ◈ **4. Coordinator TaskList 检查进度** `STATE`
  - ◈ **5. 全部 completed → 汇总结果** `STATE`
- ◆ **Task 数据结构** `DATA`
  - ◈ **id, subject, description, activeForm** `DATA`
  - ◈ **status: pending/in_progress/completed/deleted** `DATA`
  - ◈ **owner: agentId** `DATA`
  - ◈ **blocks: taskId[]** `DATA`
  - ◈ **blockedBy: taskId[]** `DATA`
  - ◈ **metadata: {...}** `DATA`
- ◆ **Task 选取规则** `STATE`
  - ◈ **status=pending && owner=空 && blockedBy=[]** `STATE`
  - ◈ **按 ID 升序优先** `STATE`
### ◆ Task Notification 协议 `DATA` — XML 格式注入父对话

- ◈ **`<task-notification>`** `DATA`
- ◆ **内嵌字段** `DATA`
  - ◈ **`<agent-id>`** `DATA`
  - ◈ **`<status>`** `DATA` — completed/failed/timeout
  - ◈ **`<output-file>`** `DATA` — 完整输出路径
  - ◈ **`<summary>`** `DATA` — 前 500 字摘要
  - ◈ **`<duration>`** `DATA`
- ◈ **父收到后用 Read 读取 output-file** `STATE`
### ◆ 远程 Agent (实验) `FLOW` — 通过 Control API 跨机器

- ◈ **POST /jobs 到远端 magi serve** `FN`
- ◈ **SSE /events 流式拉取** `FN`
- ◈ **本地代理 transcript** `FN`
- ◈ **认证: X-Magi-Token** `STATE`
### ◆ 父-子上下文隔离 `STATE` — 关键设计

- ◈ **子不继承父 messages** `STATE` — parentMessages = []
- ◈ **子有独立 system prompt** `STATE` — AgentDefinition.body
- ◈ **子有独立 tool 权限** `STATE` — allowedTools 限制
- ◈ **子的 token 不计入父预算** `STATE` — 独立计费
- ◈ **父只看到子的最终 result.text** `STATE` — 不暴露中间过程
