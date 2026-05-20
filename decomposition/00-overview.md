# Magi Agent 功能拆解 — 总览

> 本目录是对 legacy magi-agent 的行为级逆向工程文档。
> 只描述"做什么"和"怎么做"（伪代码），不包含源码。
> 用于指导 magi-next 的 clean-room 重写。

## 模块地图

```
┌─────────────────────────────────────────────────────────────┐
│                      CLI 入口 (entrypoint)                    │
│  --version | -p <prompt> | doctor | serve | 交互模式          │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                    QueryEngine (会话引擎)                      │
│  管理 mutableMessages, 调用 query(), 追踪 usage              │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│                    query() 核心循环                            │
│  LOOP: callModel → 收集 tool_use → 执行工具 → 追加结果 → 继续 │
└───────┬──────────────┬──────────────┬───────────────────────┘
        │              │              │
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │ Provider │   │  Tools  │   │ Context │
   │ Routing  │   │ System  │   │ Mgmt    │
   └────┬────┘   └────┬────┘   └────┬────┘
        │              │              │
   ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
   │ OpenAI  │   │ Bash    │   │ Memory  │
   │ Anthropic│   │ File R/W│   │ Compact │
   │ Bedrock │   │ Grep/Glob│  │ Session │
   │ Proxy   │   │ Agent   │   │ Hooks   │
   └─────────┘   │ MCP     │   └─────────┘
                  │ Web     │
                  └─────────┘

┌─────────────────────────────────────────────────────────────┐
│                    TUI (React + Ink)                          │
│  REPL Screen | Diff Approval | Overlay System | Keybindings  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Control API (HTTP)                         │
│  /sessions | /jobs | /agents | /approvals | /events (SSE)    │
└─────────────────────────────────────────────────────────────┘
```

## 文档索引

| 文件 | 内容 |
|------|------|
| `01-agent-loop.md` | 核心 agent 循环：prompt → model → tools → loop |
| `02-tools-system.md` | 工具定义、注册、权限、执行 |
| `03-provider-routing.md` | Provider 预设、格式转换、智能路由 |
| `04-memory-context.md` | 记忆系统、上下文层、压缩策略 |
| `05-session-hooks.md` | 会话持久化、Hooks、Skills、Plugins |
| `06-mcp-client.md` | MCP 传输、工具发现、审批流程 |
| `07-tui-system.md` | 终端 UI 渲染、键盘输入、Diff 审批 |

## 核心数据流（一次完整请求）

```
1. 用户输入 prompt
2. QueryEngine.submitMessage(prompt)
   2.1 处理 slash commands / attachments
   2.2 构建 system prompt (CLAUDE.md + memory + git context)
   2.3 选择相关 memories (Sonnet 选 ≤5 条)
   2.4 调用 query() generator
3. query() 循环:
   3.1 如果需要 autocompact → 压缩上下文
   3.2 callModel(messages, tools) → 流式响应
   3.3 如果 LLM 返回 tool_use blocks:
       3.3.1 执行工具 (可并行/串行)
       3.3.2 收集 tool_result
       3.3.3 追加到 messages
       3.3.4 GOTO 3.1 (下一轮)
   3.4 如果 LLM 返回纯文本 → 结束循环
   3.5 错误恢复:
       - prompt_too_long → compact 后重试
       - max_output_tokens → 追加恢复消息重试
       - fallback → 切换模型重试
4. 结果流式输出给用户
5. 记录到 session transcript
6. 更新 usage/cost
```

## 与 magi-next 当前状态的对应

> 最后更新: 2026-05-17 — Codex 开发两轮后实测 222 test pass, 0 fail

| 功能 | legacy 实现 | magi-next 状态 |
|------|------------|---------------|
| Agent 循环 | query() + StreamingToolExecutor + fallback + hooks 集成 | ✅ 完整 query() 状态机（src/agent/query.ts, 526 行）|
| 工具系统 | 60+ tools, Zod schema, permission | ✅ 19 个内置工具（src/tools/registry.ts + 18 个模块文件）|
| Provider 路由 | Preset + Proxy + format 转换 + ModelRouter 评分 | ✅ 基础 fallback 链（无 ModelRouter/格式转换 Proxy）|
| 记忆系统 | Auto memory + Sonnet 选择 + 6 层上下文构建 | ✅ 基础 append/read/delete（无 Sonnet 选择、无 6 层构建）|
| 上下文压缩 | Microcompact + LLM summarize + post-compact 恢复 | ✅ 实现完整（src/context/compaction.ts, 370 行，有 microcompact/LLM summarized/recover）|
| 会话/Session | JSONL + resume + history | ✅ SQLite（src/session-store.ts）|
| Hooks 系统 | 26 种 HookEvent × 4 种 HookType | ✅ 基础 hook runner（src/hooks/runner.ts + events.ts，通用 triggerHooks，非全量 26 种）|
| MCP 客户端 | stdio/SSE/HTTP/WS/SSE-IDE/SDK/ClaudeAI-Proxy 8 种 | ✅ stdio + http 2 种（src/mcp/，含 client/connection-manager/tool-registry/approval/transport/types）|
| TUI | React + Ink + 全屏 + overlay 系统 | ⚠️ 裸 readline（src/tui.ts, 682 行，含 slash command 解析 + session 管理）|
| Subagent | AgentTool + worktree + Coordinator + 远程会话 | ⚠️ 基础 agent tools（src/agent/tools.ts）+ 基础 task queue（src/agents/task-queue.ts）|
| Diff 审批 | DiffDialog + hunk view + 代码编辑审批 | ❌ 无 UI |
| 其他新增 | — | ✅ LSP 工具、Cron 调度、WebFetch/WebSearch、AskUserQuestion/SendUserMessage、TodoWrite/ToolSearch、workspace 诊断 |

### 当前已有工具的完整列表（19 个）:

`FileRead`, `FileWrite`, `FileEdit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `SendUserMessage`, `CronCreate`, `CronUpdate`, `CronDelete`, `CronList`, `TodoWrite`, `ToolSearch`, `Config`, `Skill`, `LSP`

### 当前缺失的核心功能（按优先级）:
1. ❌ ModelRouter 智能路由（任务分类 + 评分）
2. ❌ API 格式转换 Proxy（Anthropic IR ↔ OpenAI Chat）
3. ❌ Sonnet 记忆相关性选择（selectRelevantMemories）
4. ❌ 6 层上下文构建（当前只有简单拼接）
5. ❌ MCP SSE/WebSocket/SSE-IDE/SDK/ClaudeAI-Proxy 传输
6. ❌ MCP Session 过期重连
7. ❌ MCP 资源发现/读取/Prompts/Sampling
8. ❌ 全量 26 种 HookEvent
9. ❌ Plugin marketplace 系统
10. ❌ Diff 审批 UI
11. ❌ 全屏 TUI（React + Ink 或替代方案）
12. ❌ Streaming 流式 TUI 渲染
13. ❌ Worktree 隔离
14. ❌ 远程 Agent
