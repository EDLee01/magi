# 02 — 工具系统

## 工具接口

```
INTERFACE Tool<Input, Output>:
  name: string                          # 唯一标识 (如 "Bash", "FileRead")
  inputSchema: ZodSchema<Input>         # 输入验证
  description(input): string            # 给用户看的描述
  prompt(): string                      # 给 LLM 看的详细文档

  call(input, context) -> ToolResult<Output>   # 执行
  checkPermissions(input, context) -> "allow" | "ask" | "deny"
  isReadOnly(input): boolean            # 是否只读
  isDestructive(input): boolean         # 是否不可逆
  isConcurrencySafe(input): boolean     # 是否可并行执行
```

## 工具注册

```
FUNCTION getAvailableTools(permissionContext) -> Tool[]:
  allTools = getAllBaseTools()           # 所有内置工具
  mcpTools = getMcpTools()              # MCP 动态工具

  # 过滤
  filtered = allTools
    .filter(t => t.isEnabled())         # feature flag
    .filter(t => !isDenied(t, permissionContext))  # deny rules
    .concat(mcpTools)
    .deduplicate(by: name, prefer: builtin)

  RETURN filtered
```

## 工具列表（核心）

| 工具 | 参数 | 行为 | 审批 |
|------|------|------|------|
| **Bash** | command, timeout?, run_in_background? | 执行 shell 命令 | 危险命令需审批 |
| **FileRead** | file_path, offset?, limit? | 读文件（支持 PDF/图片/notebook） | 自动通过 |
| **FileEdit** | file_path, old_string, new_string, replace_all? | 字符串替换编辑 | 需写权限 |
| **FileWrite** | file_path, content | 创建/覆写文件 | 需写权限 |
| **Grep** | pattern, path?, glob?, output_mode? | ripgrep 搜索 | 自动通过 |
| **Glob** | pattern, path? | 文件名模式匹配 | 自动通过 |
| **WebFetch** | url, prompt | 抓取网页 + LLM 处理 | 非白名单需审批 |
| **Agent** | prompt, subagent_type?, model?, run_in_background? | 启动子 agent | 检查 deny rules |
| **MCPTool** | (动态 schema) | 调用 MCP server 工具 | 按 server 配置 |

## 权限系统

```
FUNCTION checkToolPermission(toolCall, context) -> "allow" | "ask" | "deny":
  # 1. 工具自身验证
  validation = tool.validateInput(toolCall.input)
  IF validation.error:
    RETURN "deny"

  # 2. 工具自身权限逻辑
  toolDecision = tool.checkPermissions(toolCall.input, context)
  IF toolDecision != null:
    RETURN toolDecision

  # 3. 全局权限规则
  FOR rule IN context.denyRules:
    IF rule.matches(tool.name, toolCall.input):
      RETURN "deny"

  FOR rule IN context.askRules:
    IF rule.matches(tool.name, toolCall.input):
      RETURN "ask"

  FOR rule IN context.allowRules:
    IF rule.matches(tool.name, toolCall.input):
      RETURN "allow"

  # 4. 权限模式默认行为
  SWITCH context.mode:
    CASE "bypassPermissions": RETURN "allow"
    CASE "acceptEdits": RETURN tool.isReadOnly() ? "allow" : "allow"
    CASE "default": RETURN tool.isReadOnly() ? "allow" : "ask"
```

## 权限规则格式

```
# settings.yaml 中的规则
permissions:
  allow:
    - "Bash(git status)"
    - "Bash(npm test)"
    - "FileRead(*)"
  deny:
    - "Bash(rm -rf *)"
    - "Bash(sudo *)"
  ask:
    - "Bash(git push *)"
    - "FileWrite(/etc/*)"
```

## Bash 工具详细

```
FUNCTION BashTool.call(input):
  command = input.command
  timeout = input.timeout ?? 30000

  # 危险命令检测
  IF isDangerous(command) AND NOT input.approveDangerous:
    RETURN { error: "requires approval" }

  # 执行
  IF input.run_in_background:
    taskId = spawnBackgroundTask(command, cwd, timeout)
    RETURN { backgroundTaskId: taskId }

  result = spawn("bash", ["-lc", command], { cwd, timeout })

  # 大输出持久化
  IF result.stdout.length > 30KB:
    path = persistToFile(result.stdout)
    RETURN { stdout: preview(result.stdout), persistedOutputPath: path }

  RETURN { stdout, stderr, exitCode }

FUNCTION isDangerous(command) -> boolean:
  patterns = [
    /rm\s+.*-rf/,
    /sudo/,
    /mkfs/,
    /dd\s+.*of=/,
    /chmod\s+777/,
    /curl.*\|\s*bash/
  ]
  RETURN patterns.some(p => p.test(command))
```

## FileEdit 工具详细

```
FUNCTION FileEditTool.call(input):
  { file_path, old_string, new_string, replace_all } = input

  # 读取当前内容
  content = readFile(file_path)

  # 验证 old_string 存在
  IF NOT content.includes(old_string):
    RETURN { error: "old_string not found in file" }

  # 验证唯一性（除非 replace_all）
  IF NOT replace_all:
    occurrences = countOccurrences(content, old_string)
    IF occurrences > 1:
      RETURN { error: "old_string is not unique, use replace_all or provide more context" }

  # 执行替换
  newContent = replace_all
    ? content.replaceAll(old_string, new_string)
    : content.replace(old_string, new_string)

  # 生成 diff
  diff = createUnifiedDiff(file_path, content, newContent)

  # 写入
  writeFile(file_path, newContent)

  RETURN { path: file_path, diff, type: "update" }
```

## Agent 工具（子 agent 启动）

```
FUNCTION AgentTool.call(input):
  { prompt, subagent_type, model, run_in_background, isolation } = input

  # 选择 agent 定义
  agentDef = resolveAgentType(subagent_type ?? "general-purpose")

  # 准备工具集（子 agent 可能有不同的工具子集）
  tools = agentDef.allowedTools ?? getDefaultTools()

  # 隔离模式
  IF isolation == "worktree":
    worktree = createGitWorktree()
    cwd = worktree.path

  # 启动
  IF run_in_background:
    taskId = registerBackgroundTask({
      type: "local_agent",
      prompt,
      agentDef,
      tools,
      cwd
    })
    startBackgroundQuery(taskId, prompt, tools)
    RETURN { status: "async_launched", agentId: taskId }

  # 同步执行
  result = AWAIT runSubagentQuery({
    prompt,
    tools,
    model: model ?? agentDef.defaultModel,
    cwd,
    parentMessages: []  # 子 agent 不继承父对话
  })

  RETURN { status: "completed", result: result.text }
```

## 工具结果大小控制

```
FUNCTION formatToolResult(result, maxChars = 30000) -> string:
  text = serialize(result)

  IF text.length <= maxChars:
    RETURN text

  # 超大结果 → 持久化到磁盘
  path = persistToFile(text)
  preview = text.slice(0, 2000) + "\n...[truncated]..."

  RETURN preview + "\n\nFull output saved to: " + path
```

## 并发执行

```
FUNCTION executeTools(toolCalls, context) -> ToolResult[]:
  # 分组：可并行 vs 必须串行
  concurrent = toolCalls.filter(t => tool(t).isConcurrencySafe())
  sequential = toolCalls.filter(t => !tool(t).isConcurrencySafe())

  # 并行执行安全的工具
  results = AWAIT Promise.all(concurrent.map(t => executeSingle(t)))

  # 串行执行不安全的工具
  FOR EACH t IN sequential:
    results.PUSH(AWAIT executeSingle(t))

  RETURN results
```
