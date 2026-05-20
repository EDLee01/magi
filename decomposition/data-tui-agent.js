// === TUI 系统 ===
const tuiTree = {
  label: 'TUI 系统',
  desc: 'src/tui/ — React + Ink 全屏渲染',
  tag: 'flow',
  icon: '🖥',
  children: [
    {
      label: '渲染栈',
      desc: '技术选型',
      tag: 'data',
      children: [
        { label: 'React (custom fork)', desc: '基于 React 18+', tag: 'state' },
        { label: 'Ink (custom fork)', desc: 'React renderer for terminal', tag: 'state' },
        { label: 'Yoga layout', desc: 'Flexbox 布局引擎', tag: 'state' },
        { label: 'ANSI escape codes', desc: '颜色 + 光标控制', tag: 'state' },
        { label: 'alternate screen buffer', desc: 'ESC[?1049h，退出后恢复', tag: 'state' }
      ]
    },
    {
      label: '主组件树',
      desc: '<App/> 根组件',
      tag: 'class',
      children: [
        {
          label: 'Top-level Screens',
          desc: 'src/screens/',
          tag: 'class',
          children: [
            { label: 'REPL.tsx (896KB)', desc: '主交互界面', tag: 'class' },
            { label: 'Doctor.tsx (73KB)', desc: '诊断界面', tag: 'class' },
            { label: 'ResumeConversation.tsx (59KB)', desc: 'Session 恢复界面', tag: 'class' }
          ]
        },
        {
          label: '<App>',
          desc: '顶层容器',
          tag: 'class',
          children: [
            {
              label: 'Layout / 状态',
              tag: 'class',
              children: [
                { label: 'FullscreenLayout.tsx (84KB)', desc: '全屏布局', tag: 'class' },
                { label: 'VirtualMessageList.tsx (148KB)', desc: '虚拟滚动消息列表', tag: 'class' },
                { label: 'StatusLine.tsx (49KB)', desc: '底部状态栏', tag: 'class' },
                { label: 'Stats.tsx (152KB)', desc: '统计/用量展示', tag: 'class' }
              ]
            },
            {
              label: '消息渲染',
              tag: 'class',
              children: [
                { label: '<UserMessage>', tag: 'class' },
                { label: '<AssistantMessage>', desc: '含 streaming', tag: 'class' },
                { label: '<ToolUseBlock>', tag: 'class' },
                { label: '<ToolResultBlock>', desc: '折叠/展开', tag: 'class' },
                { label: '<MarkdownRenderer>', tag: 'class' },
                { label: '<CodeBlock>', desc: '语法高亮', tag: 'class' },
                { label: '<DiffBlock>', tag: 'class' },
                { label: 'StructuredDiff.tsx (25KB)', tag: 'class' },
                { label: 'FileEditToolDiff.tsx (21KB)', tag: 'class' },
                { label: 'ContextVisualization.tsx (76KB)', tag: 'class' }
              ]
            },
            {
              label: '输入',
              tag: 'class',
              children: [
                { label: 'TextInput.tsx (20KB)', tag: 'class' },
                { label: 'BaseTextInput.tsx (19KB)', tag: 'class' },
                { label: 'VimTextInput.tsx (16KB)', desc: 'vim 模式输入', tag: 'class' }
              ]
            },
            {
              label: 'Dialogs / Overlays',
              tag: 'class',
              children: [
                { label: 'BridgeDialog.tsx (34KB)', desc: '远程控制桥接', tag: 'class' },
                { label: 'BypassPermissionsModeDialog', desc: '跳过权限提示', tag: 'class' },
                { label: 'AutoModeOptInDialog (13KB)', tag: 'class' },
                { label: 'CostThresholdDialog', desc: '花费阈值警示', tag: 'class' },
                { label: 'ExportDialog (19KB)', desc: '导出对话', tag: 'class' },
                { label: 'WorktreeExitDialog (35KB)', tag: 'class' },
                { label: 'TrustDialog/', desc: '信任 / 权限对话', tag: 'class' },
                { label: 'ResumeTask (38KB)', tag: 'class' },
                { label: 'QuickOpenDialog (28KB)', desc: '快速打开文件', tag: 'class' },
                { label: 'RemoteEnvironmentDialog (38KB)', tag: 'class' },
                { label: 'ThemePicker (35KB)', tag: 'class' },
                { label: 'ConsoleOAuthFlow (79KB)', desc: 'OAuth 流程', tag: 'class' }
              ]
            },
            {
              label: 'Agent / 协调',
              tag: 'class',
              children: [
                { label: 'CoordinatorAgentStatus (36KB)', desc: '协调 agent 状态', tag: 'class' },
                { label: 'AgentProgressLine (14KB)', desc: 'agent 进度条', tag: 'class' },
                { label: 'TaskListV2 (50KB)', desc: '任务列表', tag: 'class' },
                { label: 'agents/AgentsList (52KB)', tag: 'class' },
                { label: 'agents/AgentsMenu (70KB)', tag: 'class' },
                { label: 'agents/AgentDetail (23KB)', tag: 'class' },
                { label: 'agents/AgentEditor (26KB)', tag: 'class' }
              ]
            },
            {
              label: '通知 Hooks (17 个)',
              desc: 'hooks/notifs/',
              tag: 'class',
              children: [
                { label: 'useAntOrgWarningNotification', tag: 'fn' },
                { label: 'useAutoModeUnavailableNotification', tag: 'fn' },
                { label: 'useCanSwitchToExistingSubscription', tag: 'fn' },
                { label: 'useDeprecationWarningNotification', tag: 'fn' },
                { label: 'useFastModeNotification', tag: 'fn' },
                { label: 'useIDEStatusIndicator', tag: 'fn' },
                { label: 'useInstallMessages', tag: 'fn' },
                { label: 'useLspInitializationNotification', tag: 'fn' },
                { label: 'useMcpConnectivityStatus', tag: 'fn' },
                { label: 'useModelMigrationNotifications', tag: 'fn' },
                { label: 'useNpmDeprecationNotification', tag: 'fn' },
                { label: 'usePluginAutoupdateNotification', tag: 'fn' },
                { label: 'usePluginInstallationStatus', tag: 'fn' },
                { label: 'useRateLimitWarningNotification', tag: 'fn' },
                { label: 'useSettingsErrors', tag: 'fn' },
                { label: 'useStartupNotification', tag: 'fn' },
                { label: 'useTeammateShutdownNotification', tag: 'fn' }
              ]
            },
            {
              label: 'Pickers / Suggesters',
              tag: 'class',
              children: [
                { label: '<SessionPicker>', tag: 'class' },
                { label: '<ModelPicker>', tag: 'class' },
                { label: '<SlashCommandSuggester>', tag: 'class' },
                { label: '<FileMentionSuggester>', tag: 'class' },
                { label: '<HelpOverlay>', tag: 'class' },
                { label: '<MemoryViewer>', tag: 'class' },
                { label: '<TaskListOverlay>', tag: 'class' },
                { label: '<AskUserQuestion>', desc: '工具触发的提问', tag: 'class' }
              ]
            }
          ]
        }
      ]
    },
    {
      label: '输入处理',
      desc: 'useInput hook',
      tag: 'flow',
      children: [
        {
          label: '特殊键',
          tag: 'data',
          children: [
            { label: '<code>Enter</code>', desc: '提交 prompt（多行模式 Shift+Enter）', tag: 'state' },
            { label: '<code>Ctrl+C</code>', desc: 'running 时中断；否则退出', tag: 'state' },
            { label: '<code>Ctrl+D</code>', desc: '空输入时退出', tag: 'state' },
            { label: '<code>Ctrl+L</code>', desc: '清屏（保留对话）', tag: 'state' },
            { label: '<code>Ctrl+R</code>', desc: '搜索历史', tag: 'state' },
            { label: '<code>Up/Down</code>', desc: 'history 浏览', tag: 'state' },
            { label: '<code>Ctrl+Up/Down</code>', desc: 'transcript 滚动', tag: 'state' },
            { label: '<code>PageUp/Down</code>', desc: 'transcript 翻页', tag: 'state' },
            { label: '<code>Tab</code>', desc: '自动补全', tag: 'state' },
            { label: '<code>Escape</code>', desc: '关闭 overlay', tag: 'state' },
            { label: '<code>Ctrl+Z</code>', desc: '挂起到后台（fg 恢复）', tag: 'state' },
            { label: '<code>Shift+Tab</code>', desc: '切换 plan/normal mode', tag: 'state' }
          ]
        },
        {
          label: '前缀触发',
          tag: 'data',
          children: [
            { label: '<code>/</code>', desc: 'slash command', tag: 'state' },
            { label: '<code>@</code>', desc: '@ 文件引用（fuzzy search）', tag: 'state' },
            { label: '<code>!</code>', desc: '!command 直接执行 shell', tag: 'state' },
            { label: '<code>#</code>', desc: '#memory 添加记忆', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: '流式输出渲染',
      desc: 'renderStreamingResponse()',
      tag: 'flow',
      children: [
        {
          label: '事件分发',
          tag: 'fn',
          children: [
            { label: 'text_delta → buffer += text → reconcile', tag: 'state' },
            { label: 'tool_use_start → showToolSpinner', tag: 'state' },
            { label: 'tool_result → hideSpinner + renderResult', tag: 'state' },
            { label: 'usage → updateStatusBar(tokens)', tag: 'state' },
            { label: 'error → renderErrorBlock', tag: 'state' },
            { label: 'approval_request → showOverlay', tag: 'state' }
          ]
        },
        {
          label: 'Markdown 增量渲染',
          tag: 'fn',
          children: [
            { label: 'micromark 流式解析', tag: 'state' },
            { label: '代码块: 检测 ``` 语言标识', tag: 'state' },
            { label: '链接渲染: OSC 8 escape', tag: 'state' },
            { label: '部分块未完成 → 显示 cursor', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: 'Diff 审批 UI',
      desc: '<DiffApprovalOverlay>',
      tag: 'flow',
      children: [
        { label: 'parseDiff(unifiedDiff) → hunks[]', tag: 'fn' },
        {
          label: 'renderDiffHunks',
          tag: 'fn',
          children: [
            { label: '+ 行: 绿色背景', tag: 'state' },
            { label: '- 行: 红色背景', tag: 'state' },
            { label: 'context: dim', tag: 'state' },
            { label: '@@ header: dim italic', tag: 'state' }
          ]
        },
        {
          label: '操作键',
          tag: 'data',
          children: [
            { label: '<code>y</code> / <code>Enter</code>', desc: '批准', tag: 'state' },
            { label: '<code>n</code> / <code>Escape</code>', desc: '拒绝', tag: 'state' },
            { label: '<code>d</code>', desc: '展开完整 diff', tag: 'state' },
            { label: '<code>e</code>', desc: '编辑后再审批', tag: 'state' },
            { label: '<code>a</code>', desc: '本会话全自动批准', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: '工具执行显示',
      desc: 'Tool spinner + result',
      tag: 'flow',
      children: [
        {
          label: 'Spinner',
          tag: 'fn',
          children: [
            { label: 'frames: ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏', desc: 'braille 旋转', tag: 'data' },
            { label: 'interval: 80ms', tag: 'data' },
            { label: '描述: tool.description(input)', tag: 'state' }
          ]
        },
        {
          label: '工具结果定制渲染',
          tag: 'fn',
          children: [
            { label: 'Bash: $ command + stdout 截断 500', tag: 'state' },
            { label: 'FileRead: "Read X (N lines)"', tag: 'state' },
            { label: 'FileEdit: "Wrote X" + compact diff', tag: 'state' },
            { label: 'Grep: "Search: P → N files"', tag: 'state' },
            { label: 'WebFetch: title + summary', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: 'Slash Command 系统',
      desc: 'SLASH_COMMANDS 注册表',
      tag: 'data',
      children: [
        { label: '<code>/help</code>', desc: '显示命令', tag: 'tool' },
        { label: '<code>/model [alias]</code>', desc: '切换模型', tag: 'tool' },
        { label: '<code>/status</code>', desc: 'session 状态', tag: 'tool' },
        { label: '<code>/memory</code>', desc: '查看记忆', tag: 'tool' },
        { label: '<code>/sessions</code>', desc: 'session 列表', tag: 'tool' },
        { label: '<code>/resume [id|query]</code>', desc: '恢复 session', tag: 'tool' },
        { label: '<code>/continue</code>', desc: '继续最近 session', tag: 'tool' },
        { label: '<code>/compact</code>', desc: '强制压缩', tag: 'tool' },
        { label: '<code>/clear</code>', desc: '清空对话', tag: 'tool' },
        { label: '<code>/diff</code>', desc: '查看当前修改', tag: 'tool' },
        { label: '<code>/exit</code>', desc: '退出', tag: 'tool' },
        { label: '<code>/cost</code>', desc: '本 session 花费', tag: 'tool' },
        { label: '<code>/cwd</code>', desc: '切换工作目录', tag: 'tool' },
        { label: '<code>/permissions</code>', desc: '查看权限规则', tag: 'tool' },
        { label: '<code>/hooks</code>', desc: '管理 hooks', tag: 'tool' },
        { label: '<code>/mcp</code>', desc: 'MCP server 列表', tag: 'tool' },
        { label: '<code>/skills</code>', desc: 'skills 列表', tag: 'tool' },
        { label: '<code>/tasks</code>', desc: 'task 列表', tag: 'tool' },
        { label: '<code>/agents</code>', desc: '后台 agent 列表', tag: 'tool' },
        { label: '<code>/fast</code>', desc: '切换 fast mode', tag: 'tool' },
        { label: '<code>/vim</code>', desc: '切换 vim 输入模式', tag: 'tool' },
        { label: '<code>/init</code>', desc: '生成 AGENTS.md', tag: 'tool' },
        { label: '<code>/{skill_name}</code>', desc: '调用用户 skill', tag: 'tool' }
      ]
    },
    {
      label: '主题/外观',
      desc: 'theme.ts',
      tag: 'data',
      children: [
        { label: 'dark (默认)', tag: 'state' },
        { label: 'light', tag: 'state' },
        { label: 'high-contrast', tag: 'state' },
        { label: '自定义颜色覆盖（YAML）', tag: 'state' }
      ]
    }
  ]
};

// === 子 Agent 系统 ===
const agentTree = {
  label: '子 Agent 系统',
  desc: 'src/agents/ — Coordinator + Worker',
  tag: 'flow',
  icon: '🤖',
  children: [
    {
      label: 'AgentTool 入口',
      desc: '工具被调用 → 启动子 agent',
      tag: 'tool',
      children: [
        {
          label: '参数',
          tag: 'data',
          children: [
            { label: '<code>description: string</code>', desc: '3-5 字短描述', tag: 'data' },
            { label: '<code>prompt: string</code>', desc: '完整任务说明', tag: 'data' },
            { label: '<code>subagent_type?</code>', desc: '类型选择', tag: 'data' },
            { label: '<code>model?</code>', desc: '"sonnet" | "opus" | "haiku" 覆盖', tag: 'data' },
            { label: '<code>run_in_background?</code>', desc: '后台运行', tag: 'data' },
            { label: '<code>isolation?</code>', desc: '"worktree" 隔离', tag: 'data' }
          ]
        }
      ]
    },
    {
      label: 'Subagent 类型',
      desc: 'AgentDefinition[]',
      tag: 'data',
      children: [
        {
          label: 'general-purpose',
          desc: '通用，可访问所有工具',
          tag: 'state',
          children: [
            { label: '默认 model: 继承父', tag: 'data' },
            { label: '工具集: 全部', tag: 'data' },
            { label: '场景: 复杂多步任务', tag: 'data' }
          ]
        },
        {
          label: 'Explore',
          desc: '快速探索代码库（只读）',
          tag: 'state',
          children: [
            { label: 'tools - Edit/Write/NotebookEdit', tag: 'data' },
            { label: 'thoroughness: quick/medium/very thorough', tag: 'data' },
            { label: '场景: 找文件、搜代码、回答代码库问题', tag: 'data' }
          ]
        },
        {
          label: 'Plan',
          desc: '设计实施方案',
          tag: 'state',
          children: [
            { label: 'tools - Edit/Write/NotebookEdit', tag: 'data' },
            { label: '产出: 步骤计划 + 关键文件 + 权衡分析', tag: 'data' }
          ]
        },
        {
          label: 'verification',
          desc: '验证实现正确性',
          tag: 'state',
          children: [
            { label: '运行 build/test/lint', tag: 'data' },
            { label: '产出: PASS/FAIL/PARTIAL + 证据', tag: 'data' }
          ]
        },
        {
          label: 'magi-guide',
          desc: '回答 Magi/Claude API 使用问题',
          tag: 'state',
          children: [
            { label: 'tools: Glob/Grep/Read/WebFetch/WebSearch', tag: 'data' }
          ]
        },
        { label: 'statusline-setup', desc: '配置状态栏（专用 prompt）', tag: 'state' },
        { label: '用户自定义', desc: '~/.magi-next/agents/*.md', tag: 'state' }
      ]
    },
    {
      label: 'AgentDefinition 文件格式',
      desc: '~/.magi-next/agents/{name}.md',
      tag: 'data',
      children: [
        { label: 'frontmatter.name', tag: 'data' },
        { label: 'frontmatter.description', tag: 'data' },
        { label: 'frontmatter.model? (sonnet/opus/haiku)', tag: 'data' },
        { label: 'frontmatter.allowedTools? (string[])', tag: 'data' },
        { label: 'frontmatter.disallowedTools? (string[])', tag: 'data' },
        { label: 'body: system prompt', tag: 'data' }
      ]
    },
    {
      label: '执行模式',
      desc: 'runSubagentQuery()',
      tag: 'flow',
      children: [
        {
          label: '前台同步',
          desc: '默认',
          tag: 'state',
          children: [
            { label: '父阻塞 await', tag: 'state' },
            { label: 'parentMessages = []', desc: '不继承父对话', tag: 'state' },
            { label: '工具调用: 父进程同上下文', tag: 'state' },
            { label: '完成后返回 result.text 给父', tag: 'state' }
          ]
        },
        {
          label: '后台异步',
          desc: 'run_in_background: true',
          tag: 'state',
          children: [
            { label: 'registerBackgroundTask', tag: 'fn' },
            { label: '生成 agentId 立即返回', tag: 'state' },
            { label: 'spawn 独立进程', tag: 'fn' },
            { label: '输出文件: tasks/{agentId}.output', tag: 'data' },
            { label: '完成 → task-notification XML 注入父', tag: 'fn' },
            { label: 'SendMessage 工具续接', tag: 'fn' }
          ]
        },
        {
          label: 'Worktree 隔离',
          desc: 'isolation: worktree',
          tag: 'state',
          children: [
            { label: 'git worktree add .claude/worktrees/{name}', tag: 'fn' },
            { label: '新分支 from HEAD', tag: 'fn' },
            { label: '子 agent cwd = worktree path', tag: 'fn' },
            { label: '完成: 无修改 → 自动 remove', tag: 'fn' },
            { label: '完成: 有修改 → 返回 worktree path + branch', tag: 'fn' }
          ]
        }
      ]
    },
    {
      label: 'Coordinator 模式',
      desc: '编排器调度多 worker',
      tag: 'flow',
      children: [
        { label: 'Coordinator 是特殊 agent', desc: '通常 model=opus', tag: 'state' },
        {
          label: '工作流',
          tag: 'fn',
          children: [
            { label: '1. TaskCreate 拆分任务', tag: 'state' },
            { label: '2. AgentTool spawn workers (并行)', tag: 'state' },
            { label: '3. workers 用 TaskUpdate 更新状态', tag: 'state' },
            { label: '4. Coordinator TaskList 检查进度', tag: 'state' },
            { label: '5. 全部 completed → 汇总结果', tag: 'state' }
          ]
        },
        {
          label: 'Task 数据结构',
          tag: 'data',
          children: [
            { label: 'id, subject, description, activeForm', tag: 'data' },
            { label: 'status: pending/in_progress/completed/deleted', tag: 'data' },
            { label: 'owner: agentId', tag: 'data' },
            { label: 'blocks: taskId[]', tag: 'data' },
            { label: 'blockedBy: taskId[]', tag: 'data' },
            { label: 'metadata: {...}', tag: 'data' }
          ]
        },
        {
          label: 'Task 选取规则',
          tag: 'state',
          children: [
            { label: 'status=pending && owner=空 && blockedBy=[]', tag: 'state' },
            { label: '按 ID 升序优先', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: 'Task Notification 协议',
      desc: 'XML 格式注入父对话',
      tag: 'data',
      children: [
        { label: '<code><task-notification></code>', tag: 'data' },
        {
          label: '内嵌字段',
          tag: 'data',
          children: [
            { label: '<code><agent-id></code>', tag: 'data' },
            { label: '<code><status></code>', desc: 'completed/failed/timeout', tag: 'data' },
            { label: '<code><output-file></code>', desc: '完整输出路径', tag: 'data' },
            { label: '<code><summary></code>', desc: '前 500 字摘要', tag: 'data' },
            { label: '<code><duration></code>', tag: 'data' }
          ]
        },
        { label: '父收到后用 Read 读取 output-file', tag: 'state' }
      ]
    },
    {
      label: '远程 Agent (实验)',
      desc: '通过 Control API 跨机器',
      tag: 'flow',
      children: [
        { label: 'POST /jobs 到远端 magi serve', tag: 'fn' },
        { label: 'SSE /events 流式拉取', tag: 'fn' },
        { label: '本地代理 transcript', tag: 'fn' },
        { label: '认证: X-Magi-Token', tag: 'state' }
      ]
    },
    {
      label: '父-子上下文隔离',
      desc: '关键设计',
      tag: 'state',
      children: [
        { label: '子不继承父 messages', desc: 'parentMessages = []', tag: 'state' },
        { label: '子有独立 system prompt', desc: 'AgentDefinition.body', tag: 'state' },
        { label: '子有独立 tool 权限', desc: 'allowedTools 限制', tag: 'state' },
        { label: '子的 token 不计入父预算', desc: '独立计费', tag: 'state' },
        { label: '父只看到子的最终 result.text', desc: '不暴露中间过程', tag: 'state' }
      ]
    }
  ]
};
