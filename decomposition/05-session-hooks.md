# 05 — 会话持久化、Hooks、Skills、Plugins

## 会话存储

```
# 存储格式: JSONL (每行一条消息)
# 位置: ~/.magi-next/sessions/ 或 SQLite

INTERFACE SessionEntry:
  type: "user" | "assistant" | "system" | "tool_result" | "compact_boundary"
  uuid: string
  parentUuid: string | null    # 消息链
  timestamp: string
  content: MessageContent
  metadata?: Record<string, unknown>

# 会话恢复流程
FUNCTION resumeSession(sessionId) -> Message[]:
  entries = loadSessionEntries(sessionId)

  # 找到最后一个 compact_boundary
  lastCompact = entries.findLast(e => e.type == "compact_boundary")

  IF lastCompact:
    # 只加载压缩后的消息
    messages = entries.filter(e => e.timestamp > lastCompact.timestamp)
  ELSE:
    messages = entries

  # 重建消息链
  RETURN reconstructChain(messages)
```

## Hooks 系统

```
ENUM HookEvent:
  pre_tool_use       # 工具执行前
  post_tool_use      # 工具执行后（成功）
  post_tool_use_failure  # 工具执行后（失败）
  session_start      # 会话开始
  session_end        # 会话结束
  pre_compact        # 压缩前
  post_compact       # 压缩后
  notification       # 通知发送时
  stop               # 用户停止 agent

ENUM HookType:
  command    # 执行 shell 命令
  prompt     # 调用 LLM
  http       # POST 到外部 URL
  agent      # 启动验证 agent

INTERFACE HookDefinition:
  event: HookEvent
  type: HookType
  if?: string              # 条件匹配 (如 "Bash(git *)")
  timeout?: number         # 超时 ms
  once?: boolean           # 只执行一次

  # type == "command"
  command?: string         # shell 命令

  # type == "prompt"
  prompt?: string          # LLM prompt
  model?: string           # 模型选择

  # type == "http"
  url?: string
  headers?: Record<string, string>

  # type == "agent"
  verificationPrompt?: string
```

## Hook 执行流程

```
FUNCTION executeHooks(event, context) -> HookResult[]:
  hooks = config.hooks.filter(h => h.event == event)
  results = []

  FOR hook IN hooks:
    # 条件匹配
    IF hook.if AND NOT matchesCondition(hook.if, context):
      CONTINUE

    # 执行
    SWITCH hook.type:
      CASE "command":
        result = AWAIT runShellCommand({
          command: hook.command,
          env: { ARGUMENTS: JSON.stringify(context) },
          timeout: hook.timeout ?? 30000
        })
        results.PUSH({ hook, output: result.stdout, exitCode: result.exitCode })

      CASE "prompt":
        result = AWAIT callModel({
          model: hook.model ?? "haiku",
          messages: [{ role: "user", content: hook.prompt + "\n\nContext:\n" + JSON.stringify(context) }]
        })
        results.PUSH({ hook, output: result.text })

      CASE "http":
        response = AWAIT fetch(hook.url, {
          method: "POST",
          headers: hook.headers,
          body: JSON.stringify(context)
        })
        results.PUSH({ hook, output: await response.text(), status: response.status })

      CASE "agent":
        result = AWAIT runSubagentQuery({
          prompt: hook.verificationPrompt,
          model: hook.model ?? "haiku",
          timeout: hook.timeout ?? 60000
        })
        results.PUSH({ hook, output: result.text })

    # once 标记
    IF hook.once:
      removeHook(hook)

  RETURN results


# 在 agent 循环中的集成点
FUNCTION executeToolWithHooks(toolCall, context):
  # Pre-hook
  preResults = executeHooks("pre_tool_use", { tool: toolCall.name, input: toolCall.input })
  FOR result IN preResults:
    IF result.exitCode == 2:  # 阻止执行
      RETURN { error: "Blocked by hook: " + result.output }

  # 执行工具
  toolResult = AWAIT executeTool(toolCall)

  # Post-hook
  postResults = executeHooks(
    toolResult.error ? "post_tool_use_failure" : "post_tool_use",
    { tool: toolCall.name, input: toolCall.input, result: toolResult }
  )

  # 注入 hook 结果到对话
  FOR result IN postResults:
    IF result.output:
      injectSystemMessage("Hook output: " + result.output)

  RETURN toolResult
```

## Skills 系统

```
INTERFACE SkillDefinition:
  ---
  name: string
  description: string
  whenToUse: string
  allowedTools?: string[]    # 工具白名单
  model?: string             # 模型覆盖
  effort?: "quick" | "medium" | "long"
  ---
  body: string               # Skill 的 prompt 内容

# Skill 发现
FUNCTION listSkills(paths) -> SkillDefinition[]:
  sources = [
    paths.skillsRoot,                    # ~/.magi-next/skills/
    path.join(cwd, ".magi/skills/"),     # 项目级 skills
  ]
  skills = []
  FOR dir IN sources:
    FOR file IN glob(dir, "*.md"):
      skills.PUSH(parseSkillFile(file))
  RETURN skills

# Skill 调用（通过 slash command）
FUNCTION invokeSkill(skillName, args, context):
  skill = findSkill(paths, skillName)
  IF NOT skill:
    RETURN { error: "Skill not found: " + skillName }

  # 构建 prompt
  prompt = skill.body.replace("$ARGUMENTS", args)

  # 如果 skill 指定了工具白名单，限制可用工具
  tools = skill.allowedTools
    ? getTools().filter(t => skill.allowedTools.includes(t.name))
    : getTools()

  # 执行
  result = AWAIT runQuery({
    prompt,
    tools,
    model: skill.model ?? currentModel
  })

  RETURN result
```

## Plugins 系统

```
INTERFACE PluginManifest:
  name: string
  version: string
  description: string
  skills?: SkillDefinition[]
  hooks?: HookDefinition[]
  mcpServers?: McpServerConfig[]

# Plugin 加载
FUNCTION loadPlugins(paths) -> Plugin[]:
  pluginDirs = glob(paths.pluginsRoot, "*/plugin.json")
  plugins = []

  FOR manifestPath IN pluginDirs:
    manifest = JSON.parse(readFile(manifestPath))
    plugins.PUSH({
      ...manifest,
      root: dirname(manifestPath),
      enabled: isPluginEnabled(manifest.name)
    })

  RETURN plugins

# Plugin marketplace
INTERFACE MarketplaceSource:
  url?: string              # HTTP marketplace
  path?: string             # 本地目录
  autoUpdate?: boolean

FUNCTION discoverMarketplaces(paths) -> MarketplaceRecord[]:
  sources = config.marketplaces ?? []
  # 也扫描本地 marketplace 目录
  localSources = glob(paths.pluginsRoot, "marketplace-*.json")
  RETURN [...sources, ...localSources].map(loadMarketplace)
```

## 配置文件结构

```yaml
# ~/.magi-next/config.yaml
version: "0.1"

control:
  bind: "127.0.0.1"
  port: 8765

providers:
  openai:
    type: openai
    apiKeyEnv: MAGI_OPENAI_KEY
    endpoint: chat
  anthropic:
    type: messages-compatible
    baseUrl: https://api.anthropic.com
    apiKeyEnv: MAGI_ANTHROPIC_KEY
    defaultModel: claude-sonnet-4-6
    format: anthropic-messages

models:
  aliases:
    main: "anthropic/claude-sonnet-4-6"
    fast: "openai/gpt-4o-mini"
  fallbacks:
    main: ["openai/gpt-4o"]

hooks:
  - event: post_tool_use
    type: command
    if: "Bash(git push *)"
    command: "echo 'Push detected'"

mcp:
  servers:
    filesystem:
      command: "npx"
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
      approval: dangerous

skills: {}
plugins: {}
```
