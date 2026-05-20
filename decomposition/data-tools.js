// === 工具系统 ===
const toolsTree = {
  label: '工具系统',
  desc: 'src/tools/ — 60+ 内置工具 + MCP 动态工具',
  tag: 'flow',
  icon: '🔧',
  children: [
    {
      label: 'Tool 接口定义',
      desc: 'src/tools/types.ts',
      tag: 'class',
      children: [
        { label: '<code>name: string</code>', desc: '唯一标识，如 "Bash", "FileRead"', tag: 'data' },
        { label: '<code>inputSchema: ZodSchema</code>', desc: '输入校验，运行时验证', tag: 'data' },
        { label: '<code>description(input): string</code>', desc: '展示给用户的简短描述', tag: 'fn' },
        { label: '<code>prompt(): string</code>', desc: '注入到 LLM 的工具文档（详尽）', tag: 'fn' },
        { label: '<code>call(input, ctx): ToolResult</code>', desc: '执行入口', tag: 'fn' },
        { label: '<code>checkPermissions(input, ctx)</code>', desc: '"allow" | "ask" | "deny" | null', tag: 'fn' },
        { label: '<code>isReadOnly(input): boolean</code>', desc: '只读 → 自动允许', tag: 'fn' },
        { label: '<code>isDestructive(input): boolean</code>', desc: '不可逆 → 强制审批', tag: 'fn' },
        { label: '<code>isConcurrencySafe(input): boolean</code>', desc: '可并行（FileRead/Grep yes，Bash/FileEdit no）', tag: 'fn' },
        { label: '<code>renderResult(result)</code>', desc: 'TUI 自定义渲染（可选）', tag: 'fn' },
        { label: '<code>isEnabled()</code>', desc: 'feature flag（如 ExperimentalAgent）', tag: 'fn' }
      ]
    },
    {
      label: '内置工具清单 (60+)',
      desc: '按类别分组，源自 src/tools/ 目录扫描',
      tag: 'flow',
      children: [
        {
          label: '📂 文件系统',
          desc: '6 个核心工具',
          tag: 'tool',
          children: [
            {
              label: 'Read (FileReadTool)',
              desc: '读文件，支持文本/PDF/图片/notebook',
              tag: 'tool',
              children: [
                { label: '<code>file_path: string</code>', desc: '绝对路径', tag: 'data' },
                { label: '<code>offset?: number</code>', desc: '行偏移（0-based）', tag: 'data' },
                { label: '<code>limit?: number</code>', desc: '最多读取行数', tag: 'data' },
                { label: '<code>pages?: string</code>', desc: 'PDF 页范围 "1-5"', tag: 'data' }
              ]
            },
            {
              label: 'Write (FileWriteTool)',
              desc: '创建/覆写文件',
              tag: 'tool',
              children: [
                { label: '<code>file_path: string</code>', tag: 'data' },
                { label: '<code>content: string</code>', desc: '完整文件内容', tag: 'data' }
              ]
            },
            {
              label: 'Edit (FileEditTool)',
              desc: '字符串替换',
              tag: 'tool',
              children: [
                { label: '<code>file_path: string</code>', tag: 'data' },
                { label: '<code>old_string: string</code>', desc: '待替换文本', tag: 'data' },
                { label: '<code>new_string: string</code>', desc: '替换为', tag: 'data' },
                { label: '<code>replace_all?: boolean</code>', desc: '默认 false', tag: 'data' }
              ]
            },
            {
              label: 'Glob (GlobTool)',
              desc: '文件名 glob，按 mtime 排序',
              tag: 'tool',
              children: [
                { label: '<code>pattern: string</code>', desc: '如 **/*.ts', tag: 'data' },
                { label: '<code>path?: string</code>', desc: '默认 cwd', tag: 'data' }
              ]
            },
            {
              label: 'Grep (GrepTool)',
              desc: 'ripgrep 包装',
              tag: 'tool',
              children: [
                { label: '<code>pattern: string</code>', desc: '正则', tag: 'data' },
                { label: '<code>path?: string</code>', tag: 'data' },
                { label: '<code>glob?: string</code>', desc: '文件 glob 过滤', tag: 'data' },
                { label: '<code>type?: string</code>', desc: 'js/py/rust 等', tag: 'data' },
                { label: '<code>output_mode</code>', desc: 'content/files_with_matches/count', tag: 'data' },
                { label: '<code>-A/-B/-C</code>', desc: '上下文行数', tag: 'data' },
                { label: '<code>context</code>', desc: '上下行 alias', tag: 'data' },
                { label: '<code>-n</code>', desc: '行号（默认 true）', tag: 'data' },
                { label: '<code>-i</code>', desc: '大小写不敏感', tag: 'data' },
                { label: '<code>head_limit</code>', desc: '默认 250，0=无限', tag: 'data' },
                { label: '<code>offset</code>', desc: '跳过前 N 项', tag: 'data' },
                { label: '<code>multiline</code>', desc: '跨行匹配', tag: 'data' }
              ]
            },
            {
              label: 'NotebookEdit (NotebookEditTool)',
              desc: 'Jupyter cell 编辑',
              tag: 'tool',
              children: [
                { label: '<code>notebook_path: string</code>', tag: 'data' },
                { label: '<code>cell_id?: string</code>', desc: '插入时的锚点 cell', tag: 'data' },
                { label: '<code>new_source: string</code>', tag: 'data' },
                { label: '<code>cell_type?</code>', desc: 'code/markdown', tag: 'data' },
                { label: '<code>edit_mode?</code>', desc: 'replace/insert/delete', tag: 'data' }
              ]
            }
          ]
        },
        {
          label: '⚙️ Shell 执行',
          desc: '3 个工具',
          tag: 'tool',
          children: [
            {
              label: 'Bash (BashTool)',
              desc: '通用 shell',
              tag: 'tool',
              children: [
                { label: '<code>command: string</code>', tag: 'data' },
                { label: '<code>timeout?: number</code>', desc: 'ms', tag: 'data' },
                { label: '<code>description?: string</code>', desc: '3-5 字描述', tag: 'data' },
                { label: '<code>run_in_background?</code>', desc: '后台执行', tag: 'data' },
                { label: '<code>dangerouslyDisableSandbox?</code>', desc: '关闭沙箱（危险）', tag: 'data' },
                { label: '<code>_simulatedSedEdit?</code>', desc: '内部 sed 替代', tag: 'data' }
              ]
            },
            { label: 'PowerShell (PowerShellTool)', desc: 'Windows PS 执行', tag: 'tool' },
            {
              label: 'REPL (REPLTool)',
              desc: '交互式 REPL session',
              tag: 'tool',
              children: [
                { label: '可访问: Read/Write/Edit/Glob/Grep/Bash/NotebookEdit/Agent', tag: 'state' }
              ]
            },
            {
              label: 'BashOutput / KillShell',
              desc: '后台 shell 控制',
              tag: 'tool',
              children: [
                { label: '<code>shell_id: string</code>', tag: 'data' },
                { label: 'BashOutput: 轮询读输出', tag: 'fn' },
                { label: 'KillShell: 终止 shell', tag: 'fn' }
              ]
            }
          ]
        },
        {
          label: '🤖 Agent / 任务',
          desc: '12+ 个工具',
          tag: 'tool',
          children: [
            {
              label: 'Agent (AgentTool, 别名 Task)',
              desc: '启动子 agent',
              tag: 'tool',
              children: [
                { label: '<code>description: string</code>', desc: '3-5 字', tag: 'data' },
                { label: '<code>prompt: string</code>', desc: '完整任务说明', tag: 'data' },
                { label: '<code>subagent_type?</code>', desc: 'general-purpose/Explore/Plan/...', tag: 'data' },
                { label: '<code>model?</code>', desc: 'sonnet/opus/haiku', tag: 'data' },
                { label: '<code>run_in_background?</code>', tag: 'data' },
                { label: '<code>name?</code>', desc: 'SendMessage 可寻址名称', tag: 'data' },
                { label: '<code>team_name?</code>', desc: '团队上下文', tag: 'data' },
                { label: '<code>isolation?</code>', desc: 'worktree | remote', tag: 'data' },
                { label: '<code>cwd?</code>', desc: '工作目录覆盖', tag: 'data' }
              ]
            },
            {
              label: 'SendMessage (SendMessageTool)',
              desc: '给已运行 agent 发消息',
              tag: 'tool',
              children: [
                { label: '<code>to: string</code>', desc: 'name / "*" / uds:&lt;sock&gt; / bridge:&lt;id&gt;', tag: 'data' },
                { label: '<code>summary?</code>', desc: '5-10 字预览', tag: 'data' },
                { label: '<code>message</code>', desc: 'string 或 StructuredMessage', tag: 'data' }
              ]
            },
            { label: 'TaskCreate', desc: 'subject, description, blockedBy?, metadata?', tag: 'tool' },
            { label: 'TaskGet', desc: 'taskId', tag: 'tool' },
            { label: 'TaskList', desc: '无参数', tag: 'tool' },
            { label: 'TaskUpdate', desc: 'taskId, status?, subject?, description?, owner?, blocks?, blockedBy?, metadata?', tag: 'tool' },
            { label: 'TaskOutput', desc: '内部结构化输出', tag: 'tool' },
            { label: 'TaskStop', desc: 'task_id (停止后台任务)', tag: 'tool' },
            { label: 'TeamCreate', desc: 'team_name, description?, agent_type?', tag: 'tool' },
            { label: 'TeamDelete', desc: '无参数（删除当前团队）', tag: 'tool' }
          ]
        },
        {
          label: '🌐 Web 工具',
          desc: '3 个工具',
          tag: 'tool',
          children: [
            {
              label: 'WebFetch (WebFetchTool)',
              tag: 'tool',
              children: [
                { label: '<code>url: string</code>', desc: '完整有效 URL', tag: 'data' },
                { label: '<code>prompt: string</code>', desc: '提取指令', tag: 'data' }
              ]
            },
            {
              label: 'WebSearch (WebSearchTool)',
              tag: 'tool',
              children: [
                { label: '<code>query: string</code>', desc: '至少 2 字符', tag: 'data' },
                { label: '<code>allowed_domains?</code>', tag: 'data' },
                { label: '<code>blocked_domains?</code>', tag: 'data' }
              ]
            },
            { label: 'WebBrowserTool', desc: 'Ant 内部 stub（feature-gated）', tag: 'tool' }
          ]
        },
        {
          label: '🔌 MCP 工具',
          desc: '4 个 + 动态注册',
          tag: 'tool',
          children: [
            { label: 'mcp (MCPTool)', desc: '万能入口，passthrough 到 MCP server', tag: 'tool' },
            {
              label: 'McpAuth (McpAuthTool)',
              desc: '动态命名 mcp__&lt;server&gt;__authenticate',
              tag: 'tool'
            },
            { label: 'ListMcpResourcesTool', desc: 'server? 过滤', tag: 'tool' },
            { label: 'ReadMcpResourceTool', desc: 'server, uri', tag: 'tool' },
            { label: '动态命名空间', desc: '<code>mcp__{server}__{tool}</code>', tag: 'state' }
          ]
        },
        {
          label: '📋 Plan / Worktree',
          desc: '4 个工具',
          tag: 'tool',
          children: [
            { label: 'EnterPlanMode', desc: '无参数', tag: 'tool' },
            {
              label: 'ExitPlanMode (V2)',
              tag: 'tool',
              children: [
                { label: '<code>allowedPrompts?</code>', desc: 'Array<{ tool: "Bash", prompt: string }>', tag: 'data' },
                { label: '<code>plan?</code>', desc: '计划文本（SDK schema）', tag: 'data' },
                { label: '<code>planFilePath?</code>', desc: '计划文件路径', tag: 'data' }
              ]
            },
            {
              label: 'EnterWorktree',
              tag: 'tool',
              children: [
                { label: '<code>name?</code>', desc: '字母/数字/./_/-，max 64', tag: 'data' }
              ]
            },
            {
              label: 'ExitWorktree',
              tag: 'tool',
              children: [
                { label: '<code>action: keep | remove</code>', tag: 'data' },
                { label: '<code>discard_changes?</code>', desc: 'remove + 有未提交时必须 true', tag: 'data' }
              ]
            }
          ]
        },
        {
          label: '💾 Skill / Memory / Config',
          desc: '4 个工具',
          tag: 'tool',
          children: [
            {
              label: 'Skill (SkillTool)',
              tag: 'tool',
              children: [
                { label: '<code>skill: string</code>', desc: '如 commit / review-pr', tag: 'data' },
                { label: '<code>args?: string</code>', tag: 'data' }
              ]
            },
            {
              label: 'Config (ConfigTool)',
              tag: 'tool',
              children: [
                { label: '<code>setting: string</code>', desc: 'theme/model 等 key', tag: 'data' },
                { label: '<code>value?</code>', desc: 'string/boolean/number，省略=读', tag: 'data' }
              ]
            },
            {
              label: 'TodoWrite (TodoWriteTool)',
              desc: '替换式 todo 列表',
              tag: 'tool',
              children: [
                { label: '<code>todos: TodoList</code>', desc: '完整新列表', tag: 'data' }
              ]
            },
            {
              label: 'ToolSearch (ToolSearchTool)',
              desc: '按需发现工具',
              tag: 'tool',
              children: [
                { label: '<code>query: string</code>', desc: '或 select:&lt;tool_name&gt;', tag: 'data' },
                { label: '<code>max_results?</code>', desc: '默认 5', tag: 'data' }
              ]
            }
          ]
        },
        {
          label: '⏰ 调度',
          desc: '4 个 Cron 工具',
          tag: 'tool',
          children: [
            {
              label: 'CronCreate (ScheduleCronTool)',
              tag: 'tool',
              children: [
                { label: '<code>cron: string</code>', desc: '5 字段本地时间', tag: 'data' },
                { label: '<code>prompt: string</code>', desc: '触发时入队的提示', tag: 'data' },
                { label: '<code>recurring?</code>', desc: '默认 true', tag: 'data' },
                { label: '<code>durable?</code>', desc: '持久化到 .claude/scheduled_tasks.json', tag: 'data' }
              ]
            },
            { label: 'CronUpdate', desc: '更新已存在 cron job', tag: 'tool' },
            { label: 'CronDelete', desc: 'id', tag: 'tool' },
            { label: 'CronList', desc: '列出全部', tag: 'tool' }
          ]
        },
        {
          label: '💬 通知 / 沟通',
          desc: '2 个工具',
          tag: 'tool',
          children: [
            {
              label: 'SendUserMessage (BriefTool, 别名 Brief)',
              tag: 'tool',
              children: [
                { label: '<code>message: string</code>', desc: 'markdown', tag: 'data' },
                { label: '<code>attachments?: string[]</code>', tag: 'data' },
                { label: '<code>status: normal | proactive</code>', tag: 'data' }
              ]
            },
            {
              label: 'AskUserQuestion (AskUserQuestionTool)',
              tag: 'tool',
              children: [
                { label: '<code>questions: Array&lt;Question&gt;</code>', desc: '1-4 个', tag: 'data' },
                { label: 'Question.question/header/options', desc: '2-4 options', tag: 'data' },
                { label: 'Option: { label, description, preview? }', tag: 'data' },
                { label: 'multiSelect?', desc: '多选', tag: 'data' }
              ]
            }
          ]
        },
        {
          label: '🔍 LSP',
          tag: 'tool',
          children: [
            {
              label: 'LSP (LSPTool)',
              desc: 'LSP 协议代理',
              tag: 'tool',
              children: [
                { label: 'goToDefinition', tag: 'state' },
                { label: 'findReferences', tag: 'state' },
                { label: 'hover', tag: 'state' },
                { label: 'documentSymbol', tag: 'state' },
                { label: 'workspaceSymbol', tag: 'state' },
                { label: 'goToImplementation', tag: 'state' },
                { label: 'prepareCallHierarchy', tag: 'state' },
                { label: 'incomingCalls / outgoingCalls', tag: 'state' },
                { label: '<code>filePath, line (1-based), character (1-based)</code>', tag: 'data' }
              ]
            }
          ]
        },
        {
          label: '🚀 Remote / 协调',
          tag: 'tool',
          children: [
            {
              label: 'RemoteTrigger (RemoteTriggerTool)',
              tag: 'tool',
              children: [
                { label: '<code>action: list/get/create/update/run</code>', tag: 'data' },
                { label: '<code>trigger_id?</code>', desc: 'get/update/run 必填', tag: 'data' },
                { label: '<code>body?</code>', desc: 'JSON for create/update', tag: 'data' }
              ]
            },
            { label: 'StructuredOutput (SyntheticOutputTool)', desc: '内部 coordinator', tag: 'tool' },
            { label: 'workflow (WorkflowTool)', desc: 'Ant 内部 stub', tag: 'tool' }
          ]
        },
        {
          label: '🟫 Ant 内部 Stubs',
          desc: 'feature-gated，外部构建为 no-op',
          tag: 'data',
          children: [
            { label: 'SleepTool', desc: '暂停执行', tag: 'state' },
            { label: 'MonitorTool', tag: 'state' },
            { label: 'ListPeersTool', tag: 'state' },
            { label: 'PushNotificationTool', tag: 'state' },
            { label: 'SnipTool', desc: '上下文截断', tag: 'state' },
            { label: 'TerminalCaptureTool', tag: 'state' },
            { label: 'ReviewArtifactTool', tag: 'state' },
            { label: 'VerifyPlanExecutionTool', tag: 'state' },
            { label: 'CtxInspectTool', tag: 'state' },
            { label: 'DiscoverSkillsTool', tag: 'state' },
            { label: 'SuggestBackgroundPRTool', tag: 'state' },
            { label: 'SubscribePRTool', tag: 'state' },
            { label: 'SendUserFileTool', tag: 'state' },
            { label: 'TungstenTool (tungsten)', desc: 'Ant 内部', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: '权限系统',
      desc: '4 层决策',
      tag: 'flow',
      children: [
        {
          label: '层 1: Tool 自验证',
          desc: 'tool.validateInput()',
          tag: 'fn',
          children: [
            { label: 'Zod schema 验证', tag: 'fn' },
            { label: '失败 → deny', tag: 'state' }
          ]
        },
        {
          label: '层 2: Tool 自定义检查',
          desc: 'tool.checkPermissions()',
          tag: 'fn',
          children: [
            { label: 'Bash: 危险命令模式 → deny', tag: 'state' },
            { label: 'FileWrite: 检查目标路径白名单', tag: 'state' },
            { label: 'WebFetch: 检查 URL 白名单', tag: 'state' }
          ]
        },
        {
          label: '层 3: 全局规则',
          desc: 'settings.yaml permissions.{allow,ask,deny}',
          tag: 'data',
          children: [
            { label: '<code>"Bash(git status)"</code>', desc: '具体子命令', tag: 'data' },
            { label: '<code>"Bash(npm:*)"</code>', desc: 'npm 任意子命令（前缀+冒号）', tag: 'data' },
            { label: '<code>"FileRead(*)"</code>', desc: '所有文件', tag: 'data' },
            { label: '<code>"FileWrite(/etc/*)"</code>', desc: 'glob 路径', tag: 'data' },
            { label: '匹配优先级: deny > ask > allow', tag: 'state' }
          ]
        },
        {
          label: '层 4: 权限模式默认',
          desc: 'context.mode',
          tag: 'data',
          children: [
            { label: '<code>default</code>', desc: '只读 allow，写操作 ask', tag: 'state' },
            { label: '<code>acceptEdits</code>', desc: '所有 allow（自动批准编辑）', tag: 'state' },
            { label: '<code>bypassPermissions</code>', desc: '完全跳过审批（危险）', tag: 'state' },
            { label: '<code>plan</code>', desc: '只读模式，禁止所有写操作', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: 'Bash 工具深度',
      desc: '最复杂的工具',
      tag: 'tool',
      children: [
        {
          label: '执行管线',
          tag: 'flow',
          children: [
            { label: '1. dangerous 检测', desc: 'rm -rf, sudo, mkfs, dd of=, chmod 777, curl|bash, > /dev/sd*', tag: 'fn' },
            { label: '2. cwd 解析', desc: '默认 session cwd，可被 ctx 覆盖', tag: 'fn' },
            { label: '3. 环境变量', desc: '继承父进程 + MAGI_* 注入', tag: 'fn' },
            { label: '4. spawn(bash, [-lc, command])', desc: 'login shell 加载 .bashrc', tag: 'fn' },
            { label: '5. 流式 stdout/stderr', desc: '边执行边返回（streaming output）', tag: 'fn' },
            { label: '6. timeout 杀进程', desc: 'SIGTERM → 5s → SIGKILL', tag: 'fn' },
            { label: '7. 大输出处理', desc: '> 30KB → write 到 ~/.magi-next/state/bash-output/{id}', tag: 'fn' }
          ]
        },
        {
          label: 'Background 模式',
          desc: 'run_in_background: true',
          tag: 'flow',
          children: [
            { label: 'spawnBackgroundTask', desc: '注册到 backgroundShells Map', tag: 'fn' },
            { label: 'shellId 返回', desc: 'BashOutput / KillShell 用此 ID', tag: 'state' },
            { label: '输出 tail 文件', desc: '~/.magi-next/state/shells/{id}.out', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: 'FileEdit 工具深度',
      desc: '最常用的写工具',
      tag: 'tool',
      children: [
        { label: 'old_string 唯一性', desc: 'countOccurrences > 1 → 报错（除非 replace_all）', tag: 'fn' },
        { label: 'old_string 不存在', desc: '直接报错，不模糊匹配', tag: 'fn' },
        { label: '空白敏感', desc: '保留 indentation，行号前缀（Read tool 输出）会被剥离', tag: 'fn' },
        { label: 'Diff 生成', desc: 'createUnifiedDiff(file, before, after)', tag: 'fn' },
        { label: '审批 UI', desc: '触发 DiffApproval overlay（y/n/d）', tag: 'fn' },
        { label: '原子写入', desc: 'write to .tmp → rename', tag: 'fn' },
        { label: '行尾保留', desc: 'CRLF/LF 检测保留原样', tag: 'fn' }
      ]
    },
    {
      label: 'Agent 工具深度',
      desc: '启动子 agent',
      tag: 'tool',
      children: [
        {
          label: 'subagent_type',
          desc: '内置 + 用户定义',
          tag: 'data',
          children: [
            { label: 'general-purpose', desc: '默认，所有工具', tag: 'state' },
            { label: 'Explore', desc: '只读探索，禁止 Edit/Write', tag: 'state' },
            { label: 'Plan', desc: '设计实施方案', tag: 'state' },
            { label: 'verification', desc: '验证实现正确性', tag: 'state' },
            { label: 'magi-guide', desc: '回答 Magi 使用问题', tag: 'state' },
            { label: 'statusline-setup', desc: '配置状态栏', tag: 'state' }
          ]
        },
        {
          label: '隔离模式',
          desc: 'isolation 参数',
          tag: 'data',
          children: [
            { label: '默认（无隔离）', desc: '继承当前 cwd', tag: 'state' },
            { label: '<code>worktree</code>', desc: 'git worktree add 临时分支', tag: 'state' },
            { label: 'cleanup', desc: 'agent 无修改 → 自动删除 worktree', tag: 'state' }
          ]
        },
        {
          label: '运行模式',
          tag: 'data',
          children: [
            { label: '前台（默认）', desc: '阻塞等待结果', tag: 'state' },
            { label: '<code>run_in_background: true</code>', desc: '返回 agentId，task notification 通知完成', tag: 'state' }
          ]
        }
      ]
    },
    {
      label: '并发执行调度',
      desc: 'executeTools(toolCalls)',
      tag: 'flow',
      children: [
        { label: '分组', desc: 'concurrent = isConcurrencySafe()，sequential = otherwise', tag: 'fn' },
        { label: 'Promise.all 并行', desc: 'concurrent.map(executeSingle)', tag: 'fn' },
        { label: '串行 await', desc: 'for sequential in order', tag: 'fn' },
        { label: '结果按调用顺序合并', desc: '保持 toolUseBlocks 顺序', tag: 'fn' }
      ]
    },
    {
      label: '工具结果处理',
      desc: 'formatToolResult(result, maxChars=30000)',
      tag: 'flow',
      children: [
        { label: '小于 30KB → 直接返回', tag: 'state' },
        { label: '大于 30KB → persistToFile + preview(2000)', tag: 'state' },
        { label: '错误结果 → is_error: true', tag: 'state' },
        { label: '图片结果 → content[].type = image', tag: 'state' }
      ]
    }
  ]
};
