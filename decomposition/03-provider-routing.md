# 03 — Provider 路由系统

## 架构概览

```
用户请求 (Magi 内部 IR 格式)
  │
  ├─ 如果是 Anthropic 格式 provider → 直接发送
  │
  └─ 如果是 OpenAI 格式 provider → 经过 Proxy 转换
       │
       anthropicToOpenai(request)
       │
       ↓ 发送到 upstream
       │
       openaiToAnthropic(response)
       │
       ↓ 返回 Magi IR 格式
```

## Provider 预设

```
INTERFACE ProviderPreset:
  id: string              # "official", "deepseek", "kimi", "lmstudio"
  name: string            # 显示名
  baseUrl: string         # API endpoint
  apiFormat: "anthropic" | "openai_chat" | "openai_responses"
  defaultModels: {
    main: string,         # 主力模型
    haiku: string,        # 快速模型
    sonnet: string,       # 平衡模型
    opus: string          # 最强模型
  }
  authStrategy: "api_key" | "auth_token" | "dual_same_token"
  modelContextWindows: Record<string, number>
  needsApiKey: boolean
```

## 模型选择优先级

```
FUNCTION resolveModel(context) -> string:
  # 优先级从高到低
  IF context.sessionOverride:       RETURN context.sessionOverride
  IF context.startupFlag (--model): RETURN context.startupFlag
  IF env.MAGI_MODEL:                RETURN env.MAGI_MODEL
  IF config.models.aliases["main"]: RETURN resolveAlias("main")
  RETURN DEFAULT_MODEL
```

## 别名解析 + Fallback 链

```
FUNCTION resolveFallbackChain(config, alias) -> ResolvedModel[]:
  """
  alias = "main"
  config.models.aliases = { main: "provider1/gpt-4o" }
  config.models.fallbacks = { main: ["provider2/claude-sonnet", "provider3/deepseek"] }

  返回: [
    { providerName: "provider1", model: "gpt-4o" },
    { providerName: "provider2", model: "claude-sonnet" },
    { providerName: "provider3", model: "deepseek" }
  ]
  """
  primary = parseModelSpec(config.models.aliases[alias])
  fallbacks = (config.models.fallbacks[alias] ?? []).map(parseModelSpec)
  RETURN [primary, ...fallbacks]

FUNCTION parseModelSpec(spec: string) -> { providerName, model }:
  # "providerName/modelId" 格式
  [provider, model] = spec.split("/")
  RETURN { providerName: provider, model }
```

## 路由执行

```
FUNCTION routeProviderRequest(input) -> RoutedResponse:
  candidates = resolveFallbackChain(input.config, input.alias)
  attempts = []

  FOR EACH candidate IN candidates:
    adapter = registry.get(candidate.providerName)

    TRY:
      response = AWAIT adapter.complete({
        model: candidate.model,
        messages: input.messages,
        tools: input.tools,
        temperature: input.temperature
      })
      attempts.PUSH({ ...candidate, ok: true })
      RETURN { response, providerName: candidate.providerName, model: candidate.model, attempts }

    CATCH error:
      attempts.PUSH({ ...candidate, ok: false, errorKind: error.kind })
      IF error.retryable:
        CONTINUE  # 尝试下一个 fallback
      ELSE:
        THROW error  # 不可重试，直接抛出

  THROW "All candidates exhausted"
```

## 智能路由（任务分类）

```
FUNCTION classifyTask(prompt: string) -> RouteKind:
  IF prompt.length < 280:                    RETURN "quick"
  IF containsCodeKeywords(prompt):           RETURN "coding"
  IF containsReasoningKeywords(prompt):      RETURN "reasoning"
  IF hasImageAttachment(prompt):             RETURN "vision"
  IF estimateTokens(prompt) > 50000:         RETURN "long_context"
  IF containsReviewKeywords(prompt):         RETURN "review"
  RETURN "coding"  # 默认

FUNCTION scoreCandidate(model, routeKind) -> number:
  score = 0

  # Provider 类型加分
  IF model.provider == "official":  score += 8
  IF model.provider == "local":     score += 6

  # 模型家族 × 任务类型
  SWITCH routeKind:
    CASE "coding":
      IF model.family == "claude":    score += 28
      IF model.family == "deepseek":  score += 24
    CASE "reasoning":
      IF model.family == "deepseek":  score += 30
      IF model.family == "claude":    score += 22
    CASE "quick":
      IF model.role == "haiku":       score += 18
    CASE "long_context":
      IF model.contextWindow >= 1M:   score += 24
    CASE "vision":
      IF model.supportsVision:        score += 20

  # 上下文窗口加分
  IF model.contextWindow >= 1000000:  score += 24
  IF model.contextWindow >= 250000:   score += 16
  IF model.contextWindow >= 128000:   score += 8

  RETURN score
```

## API 格式转换（Proxy）

```
FUNCTION anthropicToOpenaiChat(request) -> OpenAIChatRequest:
  messages = []

  # system prompt → 第一条 user message（或 system role）
  IF request.system:
    messages.PUSH({ role: "system", content: request.system })

  # 消息转换
  FOR msg IN request.messages:
    IF msg.role == "assistant" AND hasToolUse(msg):
      messages.PUSH({
        role: "assistant",
        content: msg.textContent,
        tool_calls: msg.toolUseBlocks.map(toOpenAIToolCall)
      })
    ELSE IF msg.role == "user" AND hasToolResult(msg):
      FOR result IN msg.toolResults:
        messages.PUSH({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content: result.content
        })
    ELSE:
      messages.PUSH({ role: msg.role, content: msg.textContent })

  # 工具定义转换
  tools = request.tools?.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema }
  }))

  RETURN { model: request.model, messages, tools, temperature: request.temperature }


FUNCTION openaiChatToAnthropic(response) -> AnthropicResponse:
  choice = response.choices[0]

  content = []
  IF choice.message.content:
    content.PUSH({ type: "text", text: choice.message.content })

  IF choice.message.tool_calls:
    FOR tc IN choice.message.tool_calls:
      content.PUSH({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments)
      })

  RETURN {
    content,
    usage: {
      input_tokens: response.usage.prompt_tokens,
      output_tokens: response.usage.completion_tokens
    }
  }
```

## 流式响应转换

```
FUNCTION openaiStreamToAnthropic(sseEvents) -> AsyncGenerator<AnthropicEvent>:
  """
  OpenAI SSE 格式:
    data: {"choices":[{"delta":{"content":"hello"}}]}
    data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{"}}]}}]}
    data: [DONE]

  转换为 Anthropic 事件序列:
    message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop
  """

  state = {
    messageStartSent: false,
    currentBlockIndex: -1,
    toolArgBuffers: Map<index, string>
  }

  FOR EACH event IN sseEvents:
    IF event.data == "[DONE]":
      YIELD { type: "message_stop" }
      RETURN

    chunk = JSON.parse(event.data)
    delta = chunk.choices[0].delta

    IF NOT state.messageStartSent:
      YIELD { type: "message_start", message: { role: "assistant" } }
      state.messageStartSent = true

    # 文本 delta
    IF delta.content:
      IF state.currentBlockIndex == -1 OR currentBlockType != "text":
        state.currentBlockIndex++
        YIELD { type: "content_block_start", index: state.currentBlockIndex, content_block: { type: "text" } }
      YIELD { type: "content_block_delta", delta: { type: "text_delta", text: delta.content } }

    # 工具调用 delta
    IF delta.tool_calls:
      FOR tc IN delta.tool_calls:
        IF tc.function?.name:  # 新工具调用开始
          state.currentBlockIndex++
          state.toolArgBuffers.set(tc.index, "")
          YIELD { type: "content_block_start", content_block: { type: "tool_use", id: tc.id, name: tc.function.name } }
        IF tc.function?.arguments:
          state.toolArgBuffers.get(tc.index) += tc.function.arguments
          YIELD { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: tc.function.arguments } }

    # Usage
    IF chunk.usage:
      YIELD { type: "message_delta", usage: { output_tokens: chunk.usage.completion_tokens } }
```

## 错误分类

```
FUNCTION classifyProviderError(status, body) -> ProviderError:
  SWITCH status:
    CASE 401, 403: RETURN { kind: "auth", retryable: false }
    CASE 402:      RETURN { kind: "billing", retryable: false }
    CASE 429:      RETURN { kind: "rate_limit", retryable: true, retryAfter: parseRetryAfter(headers) }
    CASE 404:      RETURN { kind: "model_not_found", retryable: false }
    CASE 413:      RETURN { kind: "context_overflow", retryable: false, shouldCompress: true }
    CASE 408:      RETURN { kind: "timeout", retryable: true }
    CASE 503:      RETURN { kind: "overloaded", retryable: true }
    CASE 500..599: RETURN { kind: "server_error", retryable: true }
    DEFAULT:       RETURN { kind: "unknown", retryable: false }
```
