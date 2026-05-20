# 04 — 记忆与上下文管理

## 记忆系统架构

```
~/.magi-next/
├── memory.md                    # 用户全局记忆（简短偏好）
└── state/
    └── project-memory/
        └── {base64url(cwd)}.md  # 项目级记忆

项目目录/
├── AGENTS.md                    # 项目规则（类似 CLAUDE.md）
└── .magi/
    └── rules/*.md               # 额外规则文件
```

## 记忆类型

```
ENUM MemoryType:
  user       # 用户角色、偏好、知识
  feedback   # 工作方式指导（纠正 + 确认）
  project    # 项目上下文、截止日期、事件
  reference  # 外部系统指针

INTERFACE MemoryEntry:
  ---
  name: string
  description: string        # 一行描述，用于相关性判断
  type: MemoryType
  ---
  body: string               # 记忆内容
```

## 记忆选择（每轮动态）

```
FUNCTION selectRelevantMemories(prompt, allMemories, limit = 5) -> Memory[]:
  """
  用快速模型（如 Haiku）从所有记忆中选出与当前 prompt 最相关的 ≤5 条
  """
  IF allMemories.length == 0:
    RETURN []

  manifest = allMemories.map(m => ({
    file: m.filename,
    name: m.frontmatter.name,
    description: m.frontmatter.description,
    type: m.frontmatter.type
  }))

  selected = AWAIT callFastModel({
    prompt: "从以下记忆中选出与用户请求最相关的（最多5条）:\n" +
            "用户请求: " + prompt + "\n" +
            "可用记忆:\n" + JSON.stringify(manifest),
    model: "haiku"
  })

  RETURN selected.map(filename => loadMemoryFile(filename))
```

## 上下文层构建

```
FUNCTION buildFullContext(params) -> { systemPrompt, messages }:
  layers = []

  # Layer 1: 系统指令
  layers.PUSH(getSystemInstructions())  # 核心行为规则

  # Layer 2: 项目规则 (AGENTS.md / CLAUDE.md)
  agentsRules = loadAgentInstructions(cwd)
  IF agentsRules:
    layers.PUSH("Project instructions:\n" + agentsRules)

  # Layer 3: 用户记忆 (MEMORY.md 索引)
  userMemory = readMemoryIndex(paths.root + "/memory.md")
  IF userMemory:
    layers.PUSH("User memory:\n" + userMemory)

  # Layer 4: 动态记忆（本轮选中的）
  relevantMemories = selectRelevantMemories(params.prompt, allMemories)
  IF relevantMemories.length > 0:
    layers.PUSH("Relevant context:\n" + relevantMemories.map(format).join("\n"))

  # Layer 5: Git 上下文
  git = getGitSummary(cwd)
  IF git.isRepository:
    layers.PUSH("Git: branch=" + git.branch + " status=" + git.status)

  # Layer 6: 当前日期
  layers.PUSH("Current date: " + today())

  systemPrompt = layers.join("\n\n")
  RETURN { systemPrompt, messages: params.messages }
```

## 上下文预算

```
CONSTANTS:
  MODEL_CONTEXT_WINDOW = 200000    # 默认 200K tokens
  RESERVED_OUTPUT = 8192           # 预留输出空间
  MAX_COMPACT_OUTPUT = 20000       # 压缩摘要最大 token
  POST_COMPACT_FILE_BUDGET = 50000 # 压缩后文件恢复预算
  POST_COMPACT_SKILL_BUDGET = 25000

FUNCTION computeContextBudget(session) -> ContextBudget:
  totalWindow = MODEL_CONTEXT_WINDOW
  systemTokens = estimateTokens(systemPrompt)
  messageTokens = estimateTokens(session.messages)
  available = totalWindow - systemTokens - RESERVED_OUTPUT

  RETURN {
    total: totalWindow,
    used: systemTokens + messageTokens,
    available: available - messageTokens,
    shouldCompact: messageTokens > available * 0.9
  }
```

## 上下文压缩

```
FUNCTION autoCompact(messages) -> Message[]:
  """
  当上下文接近窗口限制时自动压缩
  两阶段：microcompact → LLM summarize
  """

  # Stage 1: Microcompact（轻量级 token 削减）
  messages = microcompact(messages)
  # - 移除重复的工具结果
  # - 截断超长工具输出
  # - 合并连续的系统消息

  # 检查是否还需要 LLM 压缩
  IF estimateTokens(messages) < CONTEXT_THRESHOLD:
    RETURN messages

  # Stage 2: LLM Summarization
  summary = AWAIT callModel({
    model: "haiku",  # 用快速模型压缩
    messages: [{
      role: "user",
      content: "Summarize this conversation concisely, preserving:\n" +
               "- Key decisions made\n" +
               "- Files modified and their current state\n" +
               "- Pending tasks\n" +
               "- Important context for continuing\n\n" +
               formatMessages(messages)
    }],
    maxOutputTokens: MAX_COMPACT_OUTPUT
  })

  # 构建压缩后的消息
  compactedMessages = [
    { role: "user", content: "[Previous conversation summary]\n" + summary.text },
    { role: "assistant", content: "I understand. I have the context from our previous conversation. How can I help?" }
  ]

  # Post-compact: 恢复关键文件内容
  recentFiles = extractRecentFiles(messages, limit = 5)
  FOR file IN recentFiles:
    IF estimateTokens(compactedMessages) + file.tokens < POST_COMPACT_FILE_BUDGET:
      compactedMessages[0].content += "\n\n[File: " + file.path + "]\n" + file.content

  RETURN compactedMessages


FUNCTION reactiveCompact(messages) -> Message[] | null:
  """
  当遇到 prompt_too_long 错误时的紧急压缩
  """
  IF messages.length < 4:
    RETURN null  # 太短了，无法压缩

  RETURN autoCompact(messages)
```

## 记忆写入

```
FUNCTION saveMemory(input: { scope, text, paths, cwd }):
  file = memoryFile(paths, scope, cwd)
  existing = readFile(file) ?? ""

  # 追加
  newContent = existing + "\n" + text.trim() + "\n"
  writeFile(file, newContent)

  # 审计
  recordAudit({ action: "memory.append", target: file })
```

## 与 magi-next 的差距

当前 magi-next 有:
- ✅ 基础 memory.ts (append/read/format)
- ✅ AGENTS.md 加载
- ✅ context/token-budget.ts (预算计算)
- ✅ context/compaction.ts (schema)

缺失:
- ❌ 记忆相关性选择（需要 LLM 调用）
- ❌ 真正的 LLM 压缩（当前只有 schema）
- ❌ Microcompact（轻量级 token 削减）
- ❌ Post-compact 文件恢复
- ❌ 多层上下文构建（当前只有简单拼接）
