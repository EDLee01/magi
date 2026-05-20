# 01 — 核心 Agent 循环

## 概念

Agent 循环是整个系统的心脏。它实现了：
- 用户发 prompt → LLM 回复（可能包含 tool calls）→ 执行工具 → 结果送回 LLM → 循环直到 LLM 给出纯文本回复

## 伪代码

```
FUNCTION query(params: QueryParams) -> AsyncGenerator<Message>:
  """
  params:
    messages: Message[]        # 对话历史
    systemPrompt: string       # 系统提示词
    tools: ToolDefinition[]    # 可用工具列表
    abortSignal: AbortSignal   # 取消信号
    model: string              # 模型 ID
    maxTurns?: number          # 最大轮次
    temperature?: number
  """

  state = {
    messages: params.messages,
    turnCount: 0,
    recoveryAttempts: 0
  }

  YIELD { type: "request_start" }

  LOOP:
    # ─── 1. 上下文管理 ───
    IF shouldAutoCompact(state.messages):
      state.messages = autoCompact(state.messages)
      YIELD { type: "compact_boundary" }

    # ─── 2. 调用模型 ───
    assistantBlocks = []
    toolUseBlocks = []
    needsFollowUp = false

    TRY:
      stream = callModel({
        model: params.model,
        messages: state.messages,
        systemPrompt: params.systemPrompt,
        tools: params.tools,
        temperature: params.temperature
      })

      FOR EACH chunk IN stream:
        IF params.abortSignal.aborted:
          YIELD { type: "interrupted" }
          RETURN "aborted_streaming"

        IF chunk.type == "text":
          assistantBlocks.PUSH(chunk)
          YIELD { type: "text_delta", text: chunk.text }

        IF chunk.type == "tool_use":
          toolUseBlocks.PUSH(chunk)
          needsFollowUp = true

        IF chunk.type == "usage":
          YIELD { type: "usage", usage: chunk.usage }

    CATCH error:
      IF error.retryable AND hasFallbackModel():
        switchToFallbackModel()
        CONTINUE  # 重试
      ELSE:
        YIELD { type: "error", error }
        RETURN "error"

    # ─── 3. 构建 assistant message ───
    assistantMessage = {
      role: "assistant",
      content: [...assistantBlocks, ...toolUseBlocks]
    }
    state.messages.PUSH(assistantMessage)
    YIELD assistantMessage

    # ─── 4. 无工具调用 → 结束 ───
    IF NOT needsFollowUp:
      # 恢复路径
      IF withheld_prompt_too_long:
        compacted = reactiveCompact(state.messages)
        IF compacted:
          CONTINUE  # 压缩后重试

      IF withheld_max_output_tokens:
        IF state.recoveryAttempts < 3:
          state.messages.PUSH(recoveryNudge())
          state.recoveryAttempts++
          CONTINUE  # 追加提示重试

      RETURN "completed"

    # ─── 5. 执行工具 ───
    IF params.abortSignal.aborted:
      YIELD { type: "interrupted" }
      RETURN "aborted_tools"

    toolResults = []
    FOR EACH toolCall IN toolUseBlocks:
      # 权限检查
      permission = checkToolPermission(toolCall, params.permissionContext)
      IF permission == "deny":
        toolResults.PUSH({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: "Permission denied",
          is_error: true
        })
        CONTINUE

      IF permission == "ask":
        approved = YIELD { type: "approval_request", toolCall }
        IF NOT approved:
          toolResults.PUSH({
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: "User denied",
            is_error: true
          })
          CONTINUE

      # 执行
      TRY:
        result = AWAIT executeTool(toolCall)
        toolResults.PUSH({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: result.output
        })
        YIELD { type: "tool_result", toolCall, result }
      CATCH toolError:
        toolResults.PUSH({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: toolError.message,
          is_error: true
        })

    # ─── 6. 追加工具结果，继续循环 ───
    userMessage = { role: "user", content: toolResults }
    state.messages.PUSH(userMessage)

    state.turnCount++
    IF params.maxTurns AND state.turnCount >= params.maxTurns:
      YIELD { type: "max_turns_reached" }
      RETURN "max_turns"

    CONTINUE  # 回到 LOOP 顶部
```

## QueryEngine 包装层

```
CLASS QueryEngine:
  mutableMessages: Message[] = []
  totalUsage: { inputTokens, outputTokens, costUsd }
  abortController: AbortController

  ASYNC FUNCTION submitMessage(prompt: string) -> AsyncGenerator<SDKMessage>:
    # 1. 处理用户输入
    userMessage = processInput(prompt)  # slash commands, attachments
    mutableMessages.PUSH(userMessage)

    # 2. 构建系统提示
    systemPrompt = buildSystemPrompt({
      claudeMd: loadClaudeMd(),
      memory: selectRelevantMemories(prompt),
      gitContext: getGitSnapshot(),
      date: today()
    })

    # 3. 调用 query 循环
    FOR EACH event IN query({
      messages: mutableMessages,
      systemPrompt,
      tools: getAvailableTools(),
      abortSignal: abortController.signal,
      model: currentModel
    }):
      SWITCH event.type:
        CASE "text_delta":
          YIELD { type: "assistant", delta: event.text }
        CASE "tool_result":
          mutableMessages.PUSH(event)
          recordToTranscript(event)
        CASE "usage":
          totalUsage.add(event.usage)
        CASE "approval_request":
          decision = showApprovalUI(event.toolCall)
          SEND decision BACK TO generator
        CASE "error":
          YIELD { type: "error", error: event.error }

    # 4. 记录
    recordToTranscript(mutableMessages.last())
    YIELD { type: "result", usage: totalUsage }

  FUNCTION interrupt():
    abortController.abort()
```

## 关键状态转换

| 状态 | 触发条件 | 动作 |
|------|---------|------|
| 正常完成 | LLM 返回纯文本 | RETURN "completed" |
| 工具循环 | LLM 返回 tool_use | 执行工具 → 追加结果 → CONTINUE |
| 中断 | abortSignal | YIELD interrupted → RETURN |
| 模型降级 | 可重试错误 + 有 fallback | 切换模型 → CONTINUE |
| 上下文溢出 | prompt_too_long | compact → CONTINUE |
| 输出截断 | max_output_tokens | 追加恢复提示 → CONTINUE (≤3次) |
| 达到轮次上限 | turnCount >= maxTurns | RETURN "max_turns" |

## 流式工具执行（高级）

```
# StreamingToolExecutor: 在模型还在输出时就开始执行工具
# 适用于 tool_use block 完整后、模型还在输出其他 block 的情况

CLASS StreamingToolExecutor:
  pendingTools: Queue<ToolCall>
  completedResults: Map<id, ToolResult>

  FUNCTION addTool(toolCall):
    pendingTools.enqueue(toolCall)
    startExecution(toolCall)  # 异步启动

  ASYNC FUNCTION startExecution(toolCall):
    result = AWAIT executeTool(toolCall)
    completedResults.set(toolCall.id, result)

  FUNCTION getCompletedResults() -> ToolResult[]:
    return completedResults.drain()
```

## 与 magi-next 的差距

当前 magi-next 的 `headless.ts`:
- 只做单次 `provider.complete(messages)` → 返回文本
- 没有 tool definitions 发给 LLM
- 没有 tool_use 解析
- 没有循环
- 没有 streaming

需要实现:
1. 把 tools 定义发给 provider（IR 层已支持 `MagiToolDefinition`）
2. 解析 LLM 响应中的 tool_use blocks
3. 执行工具并收集结果
4. 循环直到纯文本回复
5. 流式输出
