// === 会话/Hooks/Skills/Plugins ===
const sessionTree = {
  label: '会话/Hooks/Skills/Plugins 系统',
  desc: 'src/session/ + src/hooks/ + src/skills/ + src/plugins/',
  tag: 'flow',
  icon: '💾',
  children: [
    {
      label: '会话存储',
      desc: 'JSONL 或 SQLite',
      tag: 'flow',
      children: [
        {
          label: '存储格式',
          desc: '每行一条 SessionEntry',
          tag: 'data',
          children: [
            { label: '<code>type</code>', desc: 'user/assistant/system/tool_result/compact_boundary', tag: 'data' },
            { label: '<code>uuid: string</code>', desc: '消息唯一 ID', tag: 'data' },
            { label: '<code>parentUuid: string|null</code>', desc: '消息链，支持分支', tag: 'data' },
            { label: '<code>timestamp: ISO string</code>', tag: 'data' },
            { label: '<code>content: MessageContent</code>', desc: 'text/tool_use/tool_result blocks', tag: 'data' },
            { label: '<code>metadata?</code>', desc: 'model, usage, cost, sessionId', tag: 'data' }
          ]
        },
        {
          label: '存储位置',
          tag: 'data',
          children: [
            { label: 'Legacy: <code>~/.magi/projects/{base64url(cwd)}/{sessionId}.jsonl</code>', tag: 'data' },
            { label: 'magi-next: <code>~/.magi-next/state/sessions.db</code> (SQLite)', tag: 'data' },
            { label: 'Schema: sessions(id, cwd, created_at), messages(...)', tag: 'data' }
          ]
        },
        {
          label: '会话恢复 resumeSession()',
          tag: 'fn',
          children: [
            { label: 'loadSessionEntries(sessionId)', desc: '读取所有行', tag: 'fn' },
            { label: 'findLast(compact_boundary)', desc: '找最后一个压缩点', tag: 'fn' },
            { label: '只加载 boundary 之后的消息', desc: 'compact 之前已被压缩到 summary', tag: 'fn' },
            { label: 'reconstructChain()', desc: '按 parentUuid 重建消息链（支持分支）', tag: 'fn' }
          ]
        },
        {
          label: '会话索引',
          desc: '加速 /sessions 列表',
          tag: 'data',
          children: [
            { label: '索引字段: id, title, lastMessage, mtime, cwd', tag: 'data' },
            { label: 'title: 自动生成（首条 user 消息前 50 字符）', tag: 'state' },
            { label: '搜索: tantivy 或 SQLite FTS5', tag: 'data' }
          ]
        }
      ]
    },
    {
      label: 'Hooks 系统',
      desc: '事件 × 类型 矩阵',
      tag: 'flow',
      children: [
        {
          label: 'HookEvent (26 种)',
          desc: '完整事件列表 — coreSchemas.ts',
          tag: 'data',
          children: [
            {
              label: '工具相关 (3)',
              tag: 'data',
              children: [
                { label: '<code>PreToolUse</code>', desc: 'tool_name, tool_input, tool_use_id — 可阻止', tag: 'state' },
                { label: '<code>PostToolUse</code>', desc: 'tool_name, tool_input, tool_response, tool_use_id', tag: 'state' },
                { label: '<code>PostToolUseFailure</code>', desc: 'tool_name, tool_input, tool_use_id, error, is_interrupt?', tag: 'state' }
              ]
            },
            {
              label: '会话生命周期 (5)',
              tag: 'data',
              children: [
                { label: '<code>SessionStart</code>', desc: 'source: startup/resume/clear/compact, agent_type?, model?', tag: 'state' },
                { label: '<code>SessionEnd</code>', desc: 'base only', tag: 'state' },
                { label: '<code>UserPromptSubmit</code>', desc: 'prompt — 用户提交时（可改写）', tag: 'state' },
                { label: '<code>Stop</code>', desc: 'stop_hook_active, last_assistant_message?', tag: 'state' },
                { label: '<code>StopFailure</code>', desc: 'error, error_details?, last_assistant_message?', tag: 'state' }
              ]
            },
            {
              label: 'Subagent (2)',
              tag: 'data',
              children: [
                { label: '<code>SubagentStart</code>', desc: 'agent_id, agent_type', tag: 'state' },
                { label: '<code>SubagentStop</code>', desc: 'agent_id, agent_transcript_path, agent_type', tag: 'state' }
              ]
            },
            {
              label: '压缩 (2)',
              tag: 'data',
              children: [
                { label: '<code>PreCompact</code>', desc: 'trigger: manual/auto, custom_instructions', tag: 'state' },
                { label: '<code>PostCompact</code>', desc: 'trigger: manual/auto, compact_summary', tag: 'state' }
              ]
            },
            {
              label: '权限 (2)',
              tag: 'data',
              children: [
                { label: '<code>PermissionRequest</code>', desc: 'tool_name, tool_input, permission_suggestions?', tag: 'state' },
                { label: '<code>PermissionDenied</code>', desc: 'tool_name, tool_input, tool_use_id, reason', tag: 'state' }
              ]
            },
            {
              label: '团队 (3)',
              tag: 'data',
              children: [
                { label: '<code>TeammateIdle</code>', desc: 'teammate_name, team_name', tag: 'state' },
                { label: '<code>TaskCreated</code>', desc: 'task_id, task_subject, task_description?, teammate_name?', tag: 'state' },
                { label: '<code>TaskCompleted</code>', desc: 'task_id, task_subject, ...', tag: 'state' }
              ]
            },
            {
              label: 'MCP Elicitation (2)',
              desc: 'MCP server 请求用户输入',
              tag: 'data',
              children: [
                { label: '<code>Elicitation</code>', desc: 'mcp_server_name, message, mode?, url?, elicitation_id?, requested_schema?', tag: 'state' },
                { label: '<code>ElicitationResult</code>', desc: 'action: accept/decline/cancel, content?', tag: 'state' }
              ]
            },
            {
              label: '配置/文件 (5)',
              tag: 'data',
              children: [
                { label: '<code>ConfigChange</code>', desc: 'source: user/project/local/policy/skills, file_path?', tag: 'state' },
                { label: '<code>WorktreeCreate</code>', desc: 'name', tag: 'state' },
                { label: '<code>WorktreeRemove</code>', desc: 'worktree_path', tag: 'state' },
                { label: '<code>InstructionsLoaded</code>', desc: 'CLAUDE.md 加载: file_path, memory_type, load_reason', tag: 'state' },
                { label: '<code>CwdChanged</code>', desc: 'old_cwd, new_cwd', tag: 'state' },
                { label: '<code>FileChanged</code>', desc: 'file_path, event: change/add/unlink', tag: 'state' }
              ]
            },
            {
              label: '其他 (2)',
              tag: 'data',
              children: [
                { label: '<code>Notification</code>', desc: 'message, title?, notification_type', tag: 'state' },
                { label: '<code>Setup</code>', desc: 'trigger: init/maintenance', tag: 'state' }
              ]
            },
            {
              label: 'Base 字段（所有事件）',
              tag: 'data',
              children: [
                { label: '<code>session_id: string</code>', tag: 'data' },
                { label: '<code>transcript_path: string</code>', tag: 'data' },
                { label: '<code>cwd: string</code>', tag: 'data' },
                { label: '<code>permission_mode?</code>', tag: 'data' },
                { label: '<code>agent_id?</code>', desc: '仅子 agent 上下文', tag: 'data' },
                { label: '<code>agent_type?</code>', desc: '子 agent 或 --agent', tag: 'data' }
              ]
            }
          ]
        },
        {
          label: 'HookType (4 种)',
          tag: 'data',
          children: [
            {
              label: 'command (BashCommandHook)',
              desc: '执行 shell',
              tag: 'state',
              children: [
                { label: '<code>command: string</code>', tag: 'data' },
                { label: '<code>if?: string</code>', desc: '权限规则过滤，如 "Bash(git *)"', tag: 'data' },
                { label: '<code>shell?</code>', desc: 'bash | powershell（默认 bash）', tag: 'data' },
                { label: '<code>timeout?</code>', desc: 'seconds', tag: 'data' },
                { label: '<code>statusMessage?</code>', desc: 'spinner 文本', tag: 'data' },
                { label: '<code>once?</code>', desc: '一次后移除', tag: 'data' },
                { label: '<code>async?</code>', desc: '后台非阻塞', tag: 'data' },
                { label: '<code>asyncRewake?</code>', desc: '后台 + exit 2 唤醒模型', tag: 'data' },
                { label: 'env.ARGUMENTS = JSON.stringify(context)', tag: 'state' },
                { label: 'exit 0=ok / 2=block / 其他=warn', tag: 'state' }
              ]
            },
            {
              label: 'prompt (PromptHook)',
              desc: '调用 LLM',
              tag: 'state',
              children: [
                { label: '<code>prompt: string</code>', desc: '使用 $ARGUMENTS 注入 context', tag: 'data' },
                { label: '<code>if?</code>', tag: 'data' },
                { label: '<code>timeout?</code>', tag: 'data' },
                { label: '<code>model?</code>', desc: '默认 small fast model', tag: 'data' },
                { label: '<code>statusMessage?</code>', tag: 'data' },
                { label: '<code>once?</code>', tag: 'data' }
              ]
            },
            {
              label: 'http (HttpHook)',
              desc: 'POST 到 URL',
              tag: 'state',
              children: [
                { label: '<code>url: string</code>', tag: 'data' },
                { label: '<code>headers?</code>', desc: '支持 $VAR_NAME 插值', tag: 'data' },
                { label: '<code>allowedEnvVars?: string[]</code>', desc: '显式插值白名单', tag: 'data' },
                { label: '<code>if? / timeout? / statusMessage? / once?</code>', tag: 'data' }
              ]
            },
            {
              label: 'agent (AgentHook)',
              desc: '启动验证 agent',
              tag: 'state',
              children: [
                { label: '<code>prompt: string</code>', desc: '$ARGUMENTS 注入', tag: 'data' },
                { label: '<code>timeout?</code>', desc: '默认 60s', tag: 'data' },
                { label: '<code>model?</code>', desc: '默认 Haiku', tag: 'data' },
                { label: '<code>if? / statusMessage? / once?</code>', tag: 'data' }
              ]
            },
            {
              label: 'Hook Matcher 结构',
              desc: 'settings.json 中',
              tag: 'data',
              children: [
                { label: '<code>matcher: string</code>', desc: '工具名、|分隔列表、空=匹配全部', tag: 'data' },
                { label: '<code>hooks: HookCommand[]</code>', desc: '同 matcher 下多个 hook', tag: 'data' }
              ]
            }
          ]
        },
        {
          label: 'HookDefinition 字段',
          tag: 'data',
          children: [
            { label: '<code>event</code>', desc: '触发事件', tag: 'data' },
            { label: '<code>type</code>', desc: '执行类型', tag: 'data' },
            { label: '<code>if?</code>', desc: '条件匹配，如 "Bash(git push *)"', tag: 'data' },
            { label: '<code>timeout?</code>', desc: '超时 ms', tag: 'data' },
            { label: '<code>once?</code>', desc: '只执行一次', tag: 'data' },
            { label: '<code>blocking?</code>', desc: 'pre_* 是否同步阻塞', tag: 'data' }
          ]
        },
        {
          label: '执行流程 executeHooks()',
          tag: 'fn',
          children: [
            { label: 'config.hooks.filter(event)', tag: 'fn' },
            { label: 'matchesCondition(hook.if, ctx)', tag: 'fn' },
            { label: 'switch hook.type 分发', tag: 'fn' },
            { label: 'collect HookResult[]', tag: 'fn' },
            { label: 'pre_*: exit 2 抛出 BlockedByHook', tag: 'fn' },
            { label: 'post_*: stdout 注入对话', tag: 'fn' }
          ]
        }
      ]
    },
    {
      label: 'Skills 系统',
      desc: '可复用的 prompt + 工具白名单',
      tag: 'flow',
      children: [
        {
          label: 'Bundled Skills (16 个)',
          desc: 'initBundledSkills() 启动注册',
          tag: 'data',
          children: [
            { label: 'update-config', desc: '配置 Magi (settings.json/hooks/permissions/env)', tag: 'tool' },
            { label: 'simplify', desc: '审查代码：reuse / quality / efficiency', tag: 'tool' },
            { label: 'verify', desc: '验证改动：跑 tests/typecheck', tag: 'tool' },
            { label: 'debug', desc: '调试 session，读 debug log', tag: 'tool' },
            { label: 'remember', desc: '审视 auto-memory，提升到 CLAUDE.md', tag: 'tool' },
            { label: 'batch', desc: '大规模并行改动，spawn 5-30 worktree agents 各开 PR', tag: 'tool' },
            { label: 'stuck', desc: 'Ant-only 诊断卡死 session', tag: 'tool' },
            { label: 'skillify', desc: '生成 skill 模板', tag: 'tool' },
            { label: 'keybindings-help', desc: '快捷键参考', tag: 'tool' },
            { label: 'loop', desc: '循环 agent 任务（AGENT_TRIGGERS gated）', tag: 'tool' },
            { label: 'schedule', desc: '调度远程 agent（AGENT_TRIGGERS_REMOTE gated）', tag: 'tool' },
            { label: 'claude-api', desc: 'Claude API 集成（BUILDING_CLAUDE_APPS gated）', tag: 'tool' },
            { label: 'claude-in-chrome', desc: 'Chrome 扩展集成', tag: 'tool' },
            { label: 'dream', desc: 'Ant-only Dream（KAIROS gated）', tag: 'tool' },
            { label: 'hunter', desc: 'artifact review (REVIEW_ARTIFACT gated)', tag: 'tool' },
            { label: 'lorem-ipsum', desc: '占位文本生成（dev/test）', tag: 'tool' }
          ]
        },
        {
          label: 'BundledSkillDefinition 字段',
          tag: 'data',
          children: [
            { label: '<code>name: string</code>', tag: 'data' },
            { label: '<code>description: string</code>', tag: 'data' },
            { label: '<code>aliases?: string[]</code>', tag: 'data' },
            { label: '<code>whenToUse?: string</code>', tag: 'data' },
            { label: '<code>argumentHint?: string</code>', tag: 'data' },
            { label: '<code>allowedTools?: string[]</code>', desc: '工具白名单', tag: 'data' },
            { label: '<code>model?: string</code>', tag: 'data' },
            { label: '<code>disableModelInvocation?</code>', desc: '不让模型自动调', tag: 'data' },
            { label: '<code>userInvocable?</code>', desc: '允许用户 / 调用', tag: 'data' },
            { label: '<code>isEnabled?: () => boolean</code>', tag: 'data' },
            { label: '<code>hooks?: HooksSettings</code>', desc: 'skill 内联 hooks', tag: 'data' },
            { label: '<code>context?: inline | fork</code>', desc: '内联 vs fork 子 session', tag: 'data' },
            { label: '<code>agent?: string</code>', desc: '指定运行的 agent 类型', tag: 'data' },
            { label: '<code>files?: Record<string, string></code>', desc: '附加参考文件落盘', tag: 'data' },
            { label: '<code>getPromptForCommand(args, ctx)</code>', desc: '动态构建 prompt', tag: 'fn' }
          ]
        },
        {
          label: 'Skill 发现',
          desc: 'listSkills()',
          tag: 'fn',
          children: [
            { label: 'Bundled (代码内注册)', tag: 'data' },
            { label: '<code>~/.magi-next/skills/*.md</code>', desc: '全局', tag: 'data' },
            { label: '<code>{cwd}/.magi/skills/*.md</code>', desc: '项目级', tag: 'data' },
            { label: 'Plugin 提供的 skills', desc: 'manifest.skills 注入', tag: 'data' }
          ]
        },
        {
          label: 'Skill 调用',
          desc: 'invokeSkill(name, args)',
          tag: 'fn',
          children: [
            { label: '$ARGUMENTS 替换 args', tag: 'fn' },
            { label: '若 allowedTools → 过滤工具池', tag: 'fn' },
            { label: '若 model → 临时切换', tag: 'fn' },
            { label: 'context=inline → 同 session 展开', tag: 'fn' },
            { label: 'context=fork → spawn 子 session', tag: 'fn' }
          ]
        }
      ]
    },
    {
      label: 'Plugins 系统',
      desc: '打包发布的扩展',
      tag: 'flow',
      children: [
        {
          label: 'PluginManifest',
          desc: 'plugin.json',
          tag: 'data',
          children: [
            { label: 'name, version, description', tag: 'data' },
            { label: '<code>skills?: SkillDefinition[]</code>', tag: 'data' },
            { label: '<code>hooks?: HookDefinition[]</code>', tag: 'data' },
            { label: '<code>mcpServers?: McpServerConfig[]</code>', tag: 'data' },
            { label: '<code>tools?: ToolModule[]</code>', desc: '动态加载的 ts/js 模块', tag: 'data' }
          ]
        },
        {
          label: 'Plugin 加载',
          tag: 'fn',
          children: [
            { label: 'glob ~/.magi-next/plugins/*/plugin.json', tag: 'fn' },
            { label: 'isPluginEnabled(name)', desc: '从 config.plugins 读', tag: 'fn' },
            { label: '注入 skills/hooks/mcp 到全局注册表', tag: 'fn' }
          ]
        },
        {
          label: 'Plugin Marketplace',
          desc: '发现源',
          tag: 'data',
          children: [
            { label: 'HTTP marketplace url', desc: 'JSON 索引', tag: 'data' },
            { label: 'local marketplace-*.json', desc: 'plugins 目录扫描', tag: 'data' },
            { label: 'autoUpdate: 定期拉取新版本', tag: 'data' }
          ]
        }
      ]
    },
    {
      label: '配置文件',
      desc: '~/.magi-next/config.yaml',
      tag: 'data',
      children: [
        { label: '<code>version: "0.1"</code>', tag: 'data' },
        { label: '<code>control.bind / port</code>', desc: 'HTTP API 监听', tag: 'data' },
        { label: '<code>providers</code>', desc: 'preset 配置 + 覆盖', tag: 'data' },
        { label: '<code>models.aliases / fallbacks</code>', tag: 'data' },
        { label: '<code>permissions.allow / ask / deny</code>', tag: 'data' },
        { label: '<code>hooks: HookDefinition[]</code>', tag: 'data' },
        { label: '<code>mcp.servers</code>', desc: 'MCP server 注册', tag: 'data' },
        { label: '<code>skills</code> / <code>plugins</code>', desc: '启用列表', tag: 'data' },
        { label: '<code>memory.enabled / autoSelect</code>', tag: 'data' },
        { label: '<code>ui.theme / fullscreen / vim</code>', tag: 'data' }
      ]
    }
  ]
};

// === MCP 客户端 ===
const mcpTree = {
  label: 'MCP 客户端',
  desc: 'src/mcp/ — Model Context Protocol',
  tag: 'flow',
  icon: '🔌',
  children: [
    {
      label: '传输层 (8 种)',
      desc: 'McpTransport — 完整 schema 列表',
      tag: 'flow',
      children: [
        {
          label: 'stdio',
          desc: '本地子进程（最常用）',
          tag: 'state',
          children: [
            { label: '<code>command: string</code>', tag: 'data' },
            { label: '<code>args: string[]</code>', tag: 'data' },
            { label: '<code>env?: Record&lt;string,string&gt;</code>', tag: 'data' },
            { label: 'StdioTransport over JSON-RPC newline-delimited', tag: 'state' },
            { label: 'process.on(exit) → 自动清理', tag: 'fn' }
          ]
        },
        {
          label: 'sse',
          desc: 'HTTP Server-Sent Events',
          tag: 'state',
          children: [
            { label: '<code>url: string</code>', tag: 'data' },
            { label: '<code>headers?</code>', tag: 'data' },
            { label: '<code>headersHelper?</code>', desc: '动态 headers 函数', tag: 'data' },
            { label: '<code>oauth?</code>', desc: 'OAuth 配置', tag: 'data' }
          ]
        },
        {
          label: 'sse-ide',
          desc: 'IDE 模式 SSE',
          tag: 'state',
          children: [
            { label: '<code>url: string</code>', tag: 'data' },
            { label: '<code>ideName: string</code>', desc: 'VSCode/JetBrains/...', tag: 'data' },
            { label: '<code>ideRunningInWindows?</code>', desc: 'IDE 运行在 Windows（路径处理）', tag: 'data' }
          ]
        },
        {
          label: 'ws',
          desc: 'WebSocket',
          tag: 'state',
          children: [
            { label: '<code>url: string</code>', desc: 'ws:// 或 wss://', tag: 'data' },
            { label: '<code>headers?</code>', tag: 'data' },
            { label: '<code>headersHelper?</code>', tag: 'data' }
          ]
        },
        {
          label: 'ws-ide',
          desc: 'IDE 模式 WebSocket',
          tag: 'state',
          children: [
            { label: '<code>url: string</code>', tag: 'data' },
            { label: '<code>ideName: string</code>', tag: 'data' },
            { label: '<code>authToken?</code>', tag: 'data' },
            { label: '<code>ideRunningInWindows?</code>', tag: 'data' }
          ]
        },
        {
          label: 'http (Streamable)',
          desc: 'MCP 2024-11 新协议',
          tag: 'state',
          children: [
            { label: '<code>url: string</code>', tag: 'data' },
            { label: '<code>headers?</code>', tag: 'data' },
            { label: '<code>oauth?</code>', tag: 'data' },
            { label: 'X-MCP-Session-Id 维持会话', tag: 'state' }
          ]
        },
        {
          label: 'sdk',
          desc: '进程内 SDK server',
          tag: 'state',
          children: [
            { label: '<code>name: string</code>', tag: 'data' },
            { label: 'InProcessTransport — 无网络/进程', tag: 'state' }
          ]
        },
        {
          label: 'claudeai-proxy',
          desc: '通过 claude.ai 代理',
          tag: 'state',
          children: [
            { label: '<code>url: string</code>', tag: 'data' },
            { label: '<code>id: string</code>', desc: '代理标识', tag: 'data' }
          ]
        }
      ]
    },
    {
      label: 'Config Scope (7 种)',
      desc: '配置作用域，决定可见性 + 优先级',
      tag: 'data',
      children: [
        { label: '<code>local</code>', desc: '当前 cwd .claude/', tag: 'state' },
        { label: '<code>user</code>', desc: '~/.claude/', tag: 'state' },
        { label: '<code>project</code>', desc: '.claude/ 提交到 git', tag: 'state' },
        { label: '<code>dynamic</code>', desc: '动态注入', tag: 'state' },
        { label: '<code>enterprise</code>', desc: '企业策略', tag: 'state' },
        { label: '<code>claudeai</code>', desc: 'claude.ai 同步', tag: 'state' },
        { label: '<code>managed</code>', desc: 'MDM 管理', tag: 'state' }
      ]
    },
    {
      label: 'OAuth Config (McpOAuthConfigSchema)',
      tag: 'data',
      children: [
        { label: '<code>clientId?</code>', tag: 'data' },
        { label: '<code>callbackPort?</code>', tag: 'data' },
        { label: '<code>authServerMetadataUrl?</code>', desc: '必须 https', tag: 'data' },
        { label: '<code>xaa?</code>', desc: 'Cross-App Access (XAA / SEP-990)', tag: 'data' }
      ]
    },
    {
      label: '连接状态',
      tag: 'data',
      children: [
        {
          label: 'ConnectedMCPServer',
          desc: 'type: "connected"',
          tag: 'state',
          children: [
            { label: 'client', tag: 'data' },
            { label: 'capabilities', tag: 'data' },
            { label: 'serverInfo?', tag: 'data' },
            { label: 'instructions?', tag: 'data' },
            { label: 'config', tag: 'data' },
            { label: 'cleanup()', tag: 'fn' }
          ]
        },
        { label: 'FailedMCPServer', desc: 'type: "failed", error?, config', tag: 'state' },
        { label: 'PendingMCPServer', desc: 'type: "pending"', tag: 'state' }
      ]
    },
    {
      label: '初始化握手',
      desc: 'McpClient.initialize()',
      tag: 'flow',
      children: [
        { label: '<code>initialize</code> request', desc: '声明 capabilities', tag: 'fn' },
        { label: '<code>protocolVersion: "2024-11-05"</code>', tag: 'data' },
        { label: '<code>capabilities: { tools, resources, prompts, sampling }</code>', tag: 'data' },
        { label: '<code>clientInfo: { name, version }</code>', tag: 'data' },
        { label: 'server 返回 serverInfo + capabilities', tag: 'fn' },
        { label: '<code>initialized</code> notification', desc: '握手完成', tag: 'fn' }
      ]
    },
    {
      label: '工具发现',
      desc: 'discoverMcpTools()',
      tag: 'fn',
      children: [
        { label: 'request("tools/list", {})', tag: 'fn' },
        { label: '命名空间', desc: 'name = "mcp__" + serverName + "__" + tool.name', tag: 'state' },
        { label: 'truncate description', desc: '上限 2048 chars', tag: 'state' },
        { label: 'inputSchema', desc: '直接转发到 LLM tool definition', tag: 'state' },
        { label: '注入到全局工具池', tag: 'state' }
      ]
    },
    {
      label: '工具执行',
      desc: 'executeMcpTool()',
      tag: 'fn',
      children: [
        { label: 'request("tools/call", { name, arguments })', tag: 'fn' },
        {
          label: '响应处理',
          tag: 'fn',
          children: [
            { label: 'content[].type=text → 拼接', tag: 'state' },
            { label: 'content[].type=image → base64 注入', tag: 'state' },
            { label: 'content[].type=resource → embedded resource', tag: 'state' },
            { label: 'isError → 标记 tool_result.is_error', tag: 'state' }
          ]
        },
        {
          label: '错误码',
          desc: 'JSON-RPC error',
          tag: 'data',
          children: [
            { label: '<code>-32001</code> Session expired → reconnect 重试', tag: 'state' },
            { label: '<code>-32042</code> Needs retry (auth) → MCP auth required', tag: 'state' },
            { label: '<code>-32603</code> Internal error → 直接报错', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: '审批流程',
      desc: 'checkMcpApproval()',
      tag: 'flow',
      children: [
        { label: '<code>approval: never</code>', desc: '永不询问', tag: 'state' },
        { label: '<code>approval: always</code>', desc: '总是询问', tag: 'state' },
        { label: '<code>approval: dangerous</code> (默认)', desc: '只对危险操作询问', tag: 'state' },
        { label: 'isMcpToolDangerous()', desc: '名字含 write/delete/execute/run/modify', tag: 'fn' }
      ]
    },
    {
      label: 'MCP 资源',
      desc: '类似文件的资源暴露',
      tag: 'flow',
      children: [
        { label: 'resources/list → uri[]', tag: 'fn' },
        { label: 'resources/read(uri) → text', tag: 'fn' },
        { label: 'resources/subscribe(uri)', desc: '订阅变更（websocket）', tag: 'fn' },
        { label: 'resources/templates/list', desc: 'URI 模板（含参数）', tag: 'fn' }
      ]
    },
    {
      label: 'MCP Prompts',
      desc: '服务器侧 prompt 模板',
      tag: 'flow',
      children: [
        { label: 'prompts/list', tag: 'fn' },
        { label: 'prompts/get(name, args) → messages[]', tag: 'fn' },
        { label: '可被 slash command 调用', tag: 'state' }
      ]
    },
    {
      label: 'MCP Sampling',
      desc: '服务器请求 client 调 LLM',
      tag: 'flow',
      children: [
        { label: 'server → client: createMessage 请求', tag: 'fn' },
        { label: 'client 调用本地 LLM provider', tag: 'fn' },
        { label: '回传 message 给 server', tag: 'fn' },
        { label: '需要用户审批', tag: 'state' }
      ]
    },
    {
      label: 'McpConnectionManager',
      desc: '生命周期',
      tag: 'class',
      children: [
        { label: 'connections: Map<serverName, McpConnection>', tag: 'data' },
        { label: 'connect(name, config)', desc: '懒加载，已存在直接复用', tag: 'fn' },
        { label: 'process.on(exit) → 清理 + 自动重连', tag: 'fn' },
        { label: 'disconnectAll()', desc: 'session_end 触发', tag: 'fn' },
        { label: 'getTools()', desc: '聚合所有 server 的工具', tag: 'fn' }
      ]
    }
  ]
};
