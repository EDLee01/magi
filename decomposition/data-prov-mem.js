// === Provider 路由 ===
const providerTree = {
  label: 'Provider 路由系统',
  desc: 'src/provider/ — Preset + Proxy + ModelRouter',
  tag: 'flow',
  icon: '🌐',
  children: [
    {
      label: 'ProviderPreset 接口',
      desc: 'src/provider/presets.ts',
      tag: 'class',
      children: [
        { label: '<code>id: string</code>', desc: '"official"/"deepseek"/"kimi"/"lmstudio"/"openrouter"', tag: 'data' },
        { label: '<code>name: string</code>', desc: '显示名', tag: 'data' },
        { label: '<code>baseUrl: string</code>', desc: 'API endpoint', tag: 'data' },
        { label: '<code>apiFormat</code>', desc: '"anthropic" | "openai_chat" | "openai_responses" | "bedrock" | "vertex"', tag: 'data' },
        { label: '<code>defaultModels</code>', desc: '{ main, haiku, sonnet, opus } 别名→具体模型', tag: 'data' },
        { label: '<code>authStrategy</code>', desc: '"api_key" | "auth_token" | "dual_same_token" | "oauth"', tag: 'data' },
        { label: '<code>modelContextWindows</code>', desc: 'Record<modelId, tokens>', tag: 'data' },
        { label: '<code>needsApiKey: boolean</code>', desc: 'lmstudio 等本地服务可不需要', tag: 'data' }
      ]
    },
    {
      label: '内置 Preset 列表',
      desc: 'PRESET_REGISTRY',
      tag: 'data',
      children: [
        { label: 'official', desc: 'Anthropic 官方 (api.anthropic.com)，apiFormat=anthropic', tag: 'data' },
        { label: 'aws-bedrock', desc: 'AWS Bedrock，IAM 认证，特殊 sigv4 签名', tag: 'data' },
        { label: 'gcp-vertex', desc: 'Google Vertex AI，GCP token 认证', tag: 'data' },
        { label: 'deepseek', desc: 'api.deepseek.com，apiFormat=openai_chat', tag: 'data' },
        { label: 'kimi', desc: 'Moonshot Kimi，apiFormat=openai_chat', tag: 'data' },
        { label: 'siliconflow', desc: '硅基流动聚合，apiFormat=openai_chat', tag: 'data' },
        { label: 'openrouter', desc: 'OpenRouter 聚合，apiFormat=openai_chat', tag: 'data' },
        { label: 'hotaitool', desc: '内部代理，gpt-5.5/claude-opus，apiFormat=openai_chat', tag: 'data' },
        { label: 'lmstudio', desc: '本地 LM Studio，localhost:1234，无 key', tag: 'data' },
        { label: 'ollama', desc: '本地 Ollama，localhost:11434', tag: 'data' }
      ]
    },
    {
      label: '模型选择优先级',
      desc: 'resolveModel(context)',
      tag: 'flow',
      children: [
        { label: '1. context.sessionOverride', desc: '/model 命令运行时切换', tag: 'state' },
        { label: '2. context.startupFlag', desc: '<code>--model</code> CLI 参数', tag: 'state' },
        { label: '3. env.MAGI_MODEL', desc: '环境变量', tag: 'state' },
        { label: '4. config.models.aliases.main', desc: 'YAML 配置', tag: 'state' },
        { label: '5. DEFAULT_MODEL', desc: '硬编码默认值', tag: 'state' }
      ]
    },
    {
      label: 'Fallback 链',
      desc: 'resolveFallbackChain(config, alias)',
      tag: 'flow',
      children: [
        {
          label: '配置示例',
          desc: 'YAML',
          tag: 'data',
          children: [
            { label: '<code>aliases.main: "anthropic/claude-sonnet-4-6"</code>', tag: 'data' },
            { label: '<code>fallbacks.main: [openai/gpt-4o, deepseek/deepseek-chat]</code>', tag: 'data' }
          ]
        },
        { label: 'parseModelSpec(spec)', desc: '"provider/model" → { providerName, model }', tag: 'fn' },
        { label: '返回 [primary, ...fallbacks]', desc: '按顺序尝试', tag: 'fn' }
      ]
    },
    {
      label: '路由执行',
      desc: 'routeProviderRequest(input)',
      tag: 'flow',
      children: [
        { label: 'FOR EACH candidate', desc: '从 fallback 链取下一个', tag: 'flow' },
        { label: 'adapter = registry.get(candidate.provider)', tag: 'fn' },
        {
          label: 'TRY: adapter.complete()',
          tag: 'fn',
          children: [
            { label: '成功 → 记录 attempts，返回', tag: 'state' },
            { label: '失败 → classifyProviderError', tag: 'fn' },
            { label: '可重试 → CONTINUE 下一个', tag: 'state' },
            { label: '不可重试 → THROW', tag: 'state' }
          ]
        },
        { label: '全部失败 → THROW "All candidates exhausted"', tag: 'state' }
      ]
    },
    {
      label: '智能路由 (ModelRouter)',
      desc: '可选：根据 prompt 自动选模型',
      tag: 'class',
      children: [
        {
          label: 'classifyTask(prompt)',
          desc: '任务分类',
          tag: 'fn',
          children: [
            { label: '<code>quick</code>', desc: 'prompt.length < 280', tag: 'state' },
            { label: '<code>coding</code>', desc: '含 "function/fix/bug/refactor/implement"', tag: 'state' },
            { label: '<code>reasoning</code>', desc: '含 "analyze/explain/why/think"', tag: 'state' },
            { label: '<code>vision</code>', desc: '附带图片', tag: 'state' },
            { label: '<code>long_context</code>', desc: 'estimateTokens > 50000', tag: 'state' },
            { label: '<code>review</code>', desc: '含 "review/check/audit"', tag: 'state' }
          ]
        },
        {
          label: 'scoreCandidate(model, taskKind)',
          desc: '加权评分',
          tag: 'fn',
          children: [
            { label: 'official: +8 / local: +6', tag: 'data' },
            { label: 'coding × claude: +28 / × deepseek: +24', tag: 'data' },
            { label: 'reasoning × deepseek: +30 / × claude: +22', tag: 'data' },
            { label: 'quick × haiku: +18', tag: 'data' },
            { label: 'context_window 1M+: +24 / 250K+: +16 / 128K+: +8', tag: 'data' },
            { label: 'vision × supportsVision: +20', tag: 'data' }
          ]
        }
      ]
    },
    {
      label: 'API 格式转换 (Proxy)',
      desc: '关键：Anthropic IR ↔ OpenAI Chat',
      tag: 'flow',
      children: [
        {
          label: 'anthropicToOpenaiChat(request)',
          desc: '请求方向',
          tag: 'fn',
          children: [
            { label: 'system → messages[0]={role:system}', tag: 'state' },
            { label: 'tool_use blocks → tool_calls[]', tag: 'state' },
            { label: 'tool_result → role=tool, tool_call_id', tag: 'state' },
            { label: 'tools → [{ type: function, function: {name, parameters} }]', tag: 'state' },
            { label: 'image content → multimodal content array', tag: 'state' }
          ]
        },
        {
          label: 'openaiChatToAnthropic(response)',
          desc: '响应方向',
          tag: 'fn',
          children: [
            { label: 'choices[0].message.content → text block', tag: 'state' },
            { label: 'tool_calls[] → tool_use blocks', tag: 'state' },
            { label: 'JSON.parse(arguments) → input', tag: 'state' },
            { label: 'usage.prompt_tokens → input_tokens', tag: 'state' }
          ]
        },
        {
          label: 'openaiStreamToAnthropic(SSE)',
          desc: '流式转换状态机',
          tag: 'fn',
          children: [
            { label: 'state.messageStartSent', desc: '只发一次 message_start', tag: 'state' },
            { label: 'state.currentBlockIndex', desc: '当前 content block 索引', tag: 'state' },
            { label: 'state.toolArgBuffers: Map<index, string>', desc: '累积 tool args 文本', tag: 'state' },
            { label: 'delta.content → content_block_delta(text_delta)', tag: 'state' },
            { label: 'delta.tool_calls → content_block_start(tool_use) + input_json_delta', tag: 'state' },
            { label: '[DONE] → message_stop', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: '错误分类',
      desc: 'classifyProviderError(status, body)',
      tag: 'data',
      children: [
        { label: '401/403 → auth, not retryable', tag: 'state' },
        { label: '402 → billing, not retryable', tag: 'state' },
        { label: '429 → rate_limit, retryable, parse Retry-After', tag: 'state' },
        { label: '404 → model_not_found, not retryable', tag: 'state' },
        { label: '413 → context_overflow, shouldCompress=true', tag: 'state' },
        { label: '408 → timeout, retryable', tag: 'state' },
        { label: '500-503 → server_error/overloaded, retryable', tag: 'state' },
        { label: 'Body 含 "prompt is too long" → withheld_prompt_too_long', tag: 'state' },
        { label: 'Body 含 "max_tokens" → withheld_max_output_tokens', tag: 'state' }
      ]
    },
    {
      label: '认证策略',
      desc: 'authStrategy 实现',
      tag: 'flow',
      children: [
        { label: 'api_key → x-api-key header', tag: 'state' },
        { label: 'auth_token → Authorization: Bearer {token}', tag: 'state' },
        { label: 'dual_same_token → 同一个 token，两种 header 都发', tag: 'state' },
        { label: 'oauth → token from keychain，自动刷新', tag: 'state' },
        { label: 'aws-sigv4 → AWS 签名 v4，IAM credentials', tag: 'state' }
      ]
    }
  ]
};

// === 记忆与上下文 ===
const memoryTree = {
  label: '记忆与上下文管理',
  desc: 'src/memory/ + src/context/',
  tag: 'flow',
  icon: '🧠',
  children: [
    {
      label: '记忆存储位置',
      desc: '文件层级',
      tag: 'data',
      children: [
        { label: '<code>~/.magi-next/memory.md</code>', desc: '全局用户记忆索引', tag: 'data' },
        { label: '<code>~/.magi-next/memory/{name}.md</code>', desc: '单条记忆文件，frontmatter + body', tag: 'data' },
        { label: '<code>~/.magi-next/state/project-memory/{base64url(cwd)}.md</code>', desc: '项目级记忆', tag: 'data' },
        { label: '<code>{cwd}/AGENTS.md</code> / CLAUDE.md', desc: '项目规则文件', tag: 'data' },
        { label: '<code>{cwd}/.magi/rules/*.md</code>', desc: '额外规则文件（递归读取）', tag: 'data' }
      ]
    },
    {
      label: '记忆类型',
      desc: 'frontmatter type 字段',
      tag: 'data',
      children: [
        { label: 'user', desc: '用户角色、偏好、知识背景', tag: 'state' },
        { label: 'feedback', desc: '工作方式指导（纠正 + 确认），含 Why/How to apply', tag: 'state' },
        { label: 'project', desc: '项目上下文、截止日期、事件，含 Why/How', tag: 'state' },
        { label: 'reference', desc: '外部系统指针（Linear/Grafana/文档链接）', tag: 'state' }
      ]
    },
    {
      label: 'MemoryEntry 结构',
      desc: 'YAML frontmatter + markdown body',
      tag: 'data',
      children: [
        { label: '<code>name: string</code>', desc: '记忆名', tag: 'data' },
        { label: '<code>description: string</code>', desc: '一行描述，用于相关性判断（critical）', tag: 'data' },
        { label: '<code>type: MemoryType</code>', desc: '4 种之一', tag: 'data' },
        { label: 'body: markdown', desc: '正文', tag: 'data' }
      ]
    },
    {
      label: '记忆相关性选择',
      desc: 'selectRelevantMemories() 每轮动态',
      tag: 'fn',
      children: [
        { label: '收集所有记忆 manifest', desc: '只用 frontmatter，不读 body', tag: 'fn' },
        { label: '调用快速模型 (Sonnet/Haiku)', desc: 'prompt: "选出最相关的 ≤5 条"', tag: 'fn' },
        { label: 'parse 返回的文件名列表', desc: 'Sonnet 返回 JSON array', tag: 'fn' },
        { label: 'loadMemoryFile() 读取 body', desc: '只对选中的读取', tag: 'fn' },
        { label: '注入到 system prompt 的 Layer 4', tag: 'state' }
      ]
    },
    {
      label: '上下文 6 层构建',
      desc: 'buildFullContext()',
      tag: 'flow',
      children: [
        { label: 'L1: 系统指令', desc: '核心行为规则（identity/safety/tone）', tag: 'state' },
        { label: 'L2: 项目规则', desc: 'AGENTS.md / CLAUDE.md', tag: 'state' },
        { label: 'L3: 用户记忆索引', desc: 'MEMORY.md（≤200 行）', tag: 'state' },
        { label: 'L4: 动态记忆', desc: '本轮选中的 ≤5 条 memory body', tag: 'state' },
        { label: 'L5: Git 上下文', desc: 'branch + status + recent commits', tag: 'state' },
        { label: 'L6: 当前日期', desc: 'today() ISO', tag: 'state' }
      ]
    },
    {
      label: '上下文预算',
      desc: 'computeContextBudget()',
      tag: 'data',
      children: [
        { label: 'MODEL_CONTEXT_WINDOW = 200000', desc: '默认 200K tokens', tag: 'data' },
        { label: 'RESERVED_OUTPUT = 8192', desc: '预留输出空间', tag: 'data' },
        { label: 'MAX_COMPACT_OUTPUT = 20000', desc: '压缩摘要上限', tag: 'data' },
        { label: 'POST_COMPACT_FILE_BUDGET = 50000', desc: '压缩后文件恢复预算', tag: 'data' },
        { label: 'POST_COMPACT_SKILL_BUDGET = 25000', desc: '压缩后 skill 恢复', tag: 'data' },
        { label: 'shouldCompact = used > available * 0.9', desc: '触发条件', tag: 'state' }
      ]
    },
    {
      label: '上下文压缩 (Compaction)',
      desc: '两阶段',
      tag: 'flow',
      children: [
        {
          label: 'Stage 1: Microcompact',
          desc: '轻量级 token 削减，无 LLM 调用',
          tag: 'fn',
          children: [
            { label: '移除重复的工具结果', tag: 'state' },
            { label: '截断超长工具输出（保留前 N + 后 N）', tag: 'state' },
            { label: '合并连续的系统消息', tag: 'state' },
            { label: '丢弃 thinking blocks（已使用过的）', tag: 'state' }
          ]
        },
        {
          label: 'Stage 2: LLM Summarize',
          desc: '用 Haiku 总结',
          tag: 'fn',
          children: [
            { label: 'prompt: "Summarize... preserving Key decisions / Files / Pending tasks / Important context"', tag: 'data' },
            { label: 'maxOutputTokens = 20000', tag: 'data' },
            { label: '替换 messages 为 [summary_user, ack_assistant]', tag: 'state' }
          ]
        },
        {
          label: 'Stage 3: Post-compact 恢复',
          desc: '关键文件重新注入',
          tag: 'fn',
          children: [
            { label: 'extractRecentFiles(messages, limit=5)', desc: '识别最近读过的文件', tag: 'fn' },
            { label: '按预算追加到 summary 后', tag: 'fn' },
            { label: '类似的 skill 内容也恢复', tag: 'fn' }
          ]
        }
      ]
    },
    {
      label: 'Reactive Compact',
      desc: '紧急压缩',
      tag: 'flow',
      children: [
        { label: '触发：prompt_too_long error', tag: 'state' },
        { label: 'messages.length < 4 → 无法压缩，throw', tag: 'state' },
        { label: '复用 autoCompact 流程', tag: 'state' },
        { label: '重试调用模型，最多 2 次', tag: 'state' }
      ]
    },
    {
      label: '记忆写入',
      desc: 'saveMemory()',
      tag: 'fn',
      children: [
        { label: '生成文件名', desc: '由 type + slug(name)', tag: 'fn' },
        { label: '写 frontmatter + body', tag: 'fn' },
        { label: '更新 MEMORY.md 索引', desc: '追加 - [name](file.md) — desc', tag: 'fn' },
        { label: '审计记录', desc: 'recordAudit({ action: memory.append })', tag: 'fn' }
      ]
    }
  ]
};
