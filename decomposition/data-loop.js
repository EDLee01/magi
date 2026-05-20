// === 核心 Agent 循环 ===
const loopTree = {
  label: 'query() 核心循环',
  desc: 'src/agent/query.ts — AsyncGenerator<SDKMessage>',
  tag: 'fn',
  icon: '⟳',
  children: [
    {
      label: 'QueryEngine 包装层',
      desc: 'src/agent/queryEngine.ts',
      tag: 'class',
      children: [
        {
          label: '状态字段',
          desc: '类成员变量',
          tag: 'data',
          children: [
            { label: '<code>mutableMessages: Message[]</code>', desc: '完整对话历史，每轮都会变更', tag: 'data' },
            { label: '<code>totalUsage</code>', desc: '{ inputTokens, outputTokens, costUsd } 累加', tag: 'data' },
            { label: '<code>abortController</code>', desc: 'AbortController，用于 Ctrl+C 中断', tag: 'data' },
            { label: '<code>currentModel</code>', desc: '当前模型 ID（可被 /model 切换）', tag: 'data' },
            { label: '<code>permissionContext</code>', desc: 'allow/ask/deny 规则 + mode', tag: 'data' },
            { label: '<code>transcriptWriter</code>', desc: 'JSONL 持久化写入器', tag: 'data' }
          ]
        },
        {
          label: 'submitMessage(prompt)',
          desc: '主入口，处理一次用户输入',
          tag: 'fn',
          children: [
            { label: '1. processInput()', desc: '解析 slash commands / @mentions / image attachments', tag: 'fn' },
            { label: '2. buildSystemPrompt()', desc: '组装 6 层上下文', tag: 'fn' },
            { label: '3. selectRelevantMemories()', desc: 'Sonnet 选 ≤5 条相关 memory', tag: 'fn' },
            { label: '4. for await query() events', desc: '消费生成器，分发事件', tag: 'flow' },
            { label: '5. recordToTranscript()', desc: '每条消息追加到 JSONL', tag: 'fn' },
            { label: '6. yield SDKMessage', desc: '回传给 UI 渲染', tag: 'flow' }
          ]
        },
        { label: 'interrupt()', desc: 'abortController.abort() — 中断 streaming + 工具执行', tag: 'fn' },
        { label: 'fork()', desc: '创建 session 副本（用于 /resume 分支）', tag: 'fn' }
      ]
    },
    {
      label: 'query() 状态机',
      desc: '主循环 LOOP 体',
      tag: 'flow',
      children: [
        {
          label: '步骤 1: 上下文管理',
          desc: '每轮开始前检查',
          tag: 'flow',
          children: [
            { label: 'shouldAutoCompact()', desc: '检查 token 占用 > window * 0.9', tag: 'fn' },
            { label: 'autoCompact()', desc: '调用 microcompact + LLM summarize', tag: 'fn' },
            { label: 'YIELD compact_boundary', desc: '插入压缩标记，session resume 时识别', tag: 'flow' }
          ]
        },
        {
          label: '步骤 2: 调用模型',
          desc: 'callModel() 流式',
          tag: 'flow',
          children: [
            {
              label: '事件类型 (chunk.type)',
              desc: '从 provider 流出',
              tag: 'data',
              children: [
                { label: '<code>text</code>', desc: '文本 delta，追加到 assistantBlocks，YIELD text_delta', tag: 'state' },
                { label: '<code>tool_use</code>', desc: '工具调用 block，pushed 到 toolUseBlocks，置 needsFollowUp=true', tag: 'state' },
                { label: '<code>thinking</code>', desc: '隐藏思考块（如 Claude extended thinking），UI 可选渲染', tag: 'state' },
                { label: '<code>usage</code>', desc: '{ input_tokens, output_tokens, cache_read } 计费', tag: 'state' },
                { label: '<code>stop</code>', desc: '流结束信号，stop_reason: end_turn / tool_use / max_tokens / stop_sequence', tag: 'state' }
              ]
            },
            { label: 'AbortSignal 检查', desc: '每个 chunk 后检查 abortSignal.aborted', tag: 'fn' },
            { label: '错误捕获', desc: 'CATCH error → if retryable && hasFallback → switchModel + CONTINUE', tag: 'fn' }
          ]
        },
        {
          label: '步骤 3: 构建 assistant message',
          desc: 'content = [...textBlocks, ...toolUseBlocks]',
          tag: 'flow',
          children: [
            { label: 'PUSH 到 mutableMessages', desc: '原地变更 messages 数组', tag: 'fn' },
            { label: 'YIELD assistantMessage', desc: '完整消息回传 UI', tag: 'flow' }
          ]
        },
        {
          label: '步骤 4: 终止判断',
          desc: 'if !needsFollowUp',
          tag: 'flow',
          children: [
            { label: 'withheld_prompt_too_long → reactiveCompact', desc: '紧急压缩重试', tag: 'state' },
            { label: 'withheld_max_output_tokens → recoveryNudge', desc: '"Continue from where you left off" 重试 ≤3 次', tag: 'state' },
            { label: 'completed → RETURN', desc: '正常退出', tag: 'state' }
          ]
        },
        {
          label: '步骤 5: 工具执行',
          desc: '关键步骤',
          tag: 'flow',
          children: [
            {
              label: '权限检查',
              desc: 'checkToolPermission()',
              tag: 'fn',
              children: [
                { label: 'allow → 直接执行', tag: 'state' },
                { label: 'deny → 返回 "Permission denied" tool_result(is_error=true)', tag: 'state' },
                { label: 'ask → YIELD approval_request → 等待 UI 决定', tag: 'state' }
              ]
            },
            {
              label: '执行分发',
              desc: 'StreamingToolExecutor',
              tag: 'class',
              children: [
                { label: 'isConcurrencySafe → Promise.all 并行', tag: 'state' },
                { label: '否则串行 await', tag: 'state' },
                { label: 'pre_tool_use hook 同步执行（exit 2 阻止）', tag: 'fn' },
                { label: 'post_tool_use hook 收集 → 注入 system message', tag: 'fn' }
              ]
            },
            {
              label: 'tool_result 构建',
              tag: 'data',
              children: [
                { label: '<code>{ type: "tool_result", tool_use_id, content, is_error? }</code>', tag: 'data' },
                { label: '大输出 (>30KB) → persistToFile + preview', tag: 'fn' },
                { label: 'CATCH toolError → content=err.msg, is_error=true', tag: 'fn' }
              ]
            }
          ]
        },
        {
          label: '步骤 6: 追加结果 + CONTINUE',
          desc: 'user message = { role: "user", content: toolResults }',
          tag: 'flow',
          children: [
            { label: 'turnCount++', tag: 'fn' },
            { label: 'maxTurns 检查 → YIELD max_turns_reached', tag: 'fn' },
            { label: 'GOTO LOOP top', tag: 'flow' }
          ]
        }
      ]
    },
    {
      label: 'StreamingToolExecutor',
      desc: '高级：模型还在输出时就开始执行工具',
      tag: 'class',
      children: [
        { label: '<code>pendingTools: Queue<ToolCall></code>', tag: 'data' },
        { label: '<code>completedResults: Map<id, ToolResult></code>', tag: 'data' },
        { label: 'addTool(toolCall)', desc: 'enqueue + startExecution（异步启动）', tag: 'fn' },
        { label: 'startExecution(toolCall)', desc: 'await executeTool → set 到 completedResults', tag: 'fn' },
        { label: 'getCompletedResults()', desc: 'drain Map，按调用顺序返回', tag: 'fn' },
        { label: 'abort()', desc: '取消所有 pending Promise', tag: 'fn' }
      ]
    },
    {
      label: '状态转换表',
      desc: '所有可能的退出路径',
      tag: 'state',
      children: [
        { label: 'completed', desc: 'LLM 返回纯文本，无 tool_use', tag: 'state' },
        { label: 'tool_loop_continue', desc: 'LLM 返回 tool_use → 执行 → 追加结果', tag: 'state' },
        { label: 'aborted_streaming', desc: '流式过程中收到 abort', tag: 'state' },
        { label: 'aborted_tools', desc: '工具执行前收到 abort', tag: 'state' },
        { label: 'fallback_switched', desc: '可重试错误 → 切换模型重试', tag: 'state' },
        { label: 'compacted_retry', desc: 'prompt_too_long → 压缩后重试', tag: 'state' },
        { label: 'recovery_nudged', desc: 'max_output_tokens → 追加恢复提示', tag: 'state' },
        { label: 'max_turns', desc: '达到 maxTurns 上限', tag: 'state' },
        { label: 'fatal_error', desc: '不可重试错误', tag: 'state' }
      ]
    },
    {
      label: 'YIELD 事件清单',
      desc: '所有可能 yield 的事件类型',
      tag: 'data',
      children: [
        { label: '<code>request_start</code>', desc: '请求开始（含 timestamp、messageId）', tag: 'data' },
        { label: '<code>compact_boundary</code>', desc: '压缩点标记', tag: 'data' },
        { label: '<code>text_delta</code>', desc: '增量文本，UI 累加渲染', tag: 'data' },
        { label: '<code>tool_use</code>', desc: '完整工具调用（id, name, input）', tag: 'data' },
        { label: '<code>tool_result</code>', desc: '工具执行结果', tag: 'data' },
        { label: '<code>approval_request</code>', desc: '需要用户审批，等待回传', tag: 'data' },
        { label: '<code>usage</code>', desc: 'token 计费', tag: 'data' },
        { label: '<code>error</code>', desc: '可恢复或致命错误', tag: 'data' },
        { label: '<code>interrupted</code>', desc: '被 abortSignal 中断', tag: 'data' },
        { label: '<code>max_turns_reached</code>', desc: '达到轮次上限', tag: 'data' },
        { label: '<code>result</code>', desc: '会话结束总结（usage、duration）', tag: 'data' }
      ]
    }
  ]
};
