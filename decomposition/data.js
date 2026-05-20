// === CLI 入口 ===
const cliTree = {
  label: 'CLI 入口 (entrypoint)',
  desc: 'src/entrypoint/main.ts — Bun 启动，commander 解析',
  tag: 'flow',
  icon: '⌨',
  children: [
    {
      label: '快速路径 (Fast Paths)',
      desc: '不进入 React/Ink 渲染，直接处理后退出',
      tag: 'flow',
      children: [
        { label: '<code>--version</code> / <code>-v</code>', desc: '打印版本号后退出', tag: 'fn' },
        { label: '<code>doctor</code>', desc: '环境诊断：node 版本、bun 版本、git、API key 可用性、provider 连通性', tag: 'fn' },
        { label: '<code>serve</code>', desc: '启动 HTTP Control API，监听 127.0.0.1:8765，暴露 /sessions /jobs /agents /approvals /events(SSE)', tag: 'fn' },
        { label: '<code>config show</code>', desc: '打印解析后的合并配置（去除 secrets）', tag: 'fn' },
        { label: '<code>config edit</code>', desc: '打开 $EDITOR 编辑 ~/.magi/config.yaml', tag: 'fn' },
        { label: '<code>migrate</code>', desc: 'Schema 迁移：v0.8 → v0.9 sessions DB / config 字段', tag: 'fn' },
        { label: '<code>auth login</code>', desc: 'OAuth 流：开浏览器 → 回调 → 写入 token 到 keychain', tag: 'fn' },
        { label: '<code>auth logout</code>', desc: '清除 token', tag: 'fn' }
      ]
    },
    {
      label: '主入口流程',
      desc: '没有命中快速路径时进入',
      tag: 'flow',
      children: [
        { label: '加载配置', desc: '~/.magi/config.yaml + 项目级 .magi/config.yaml + 环境变量覆盖', tag: 'fn' },
        { label: '解析 CLI flags', desc: '<code>-p/--prompt</code> headless / <code>--model</code> / <code>--cwd</code> / <code>--resume</code> / <code>--continue</code> / <code>--print</code> / <code>--output-format</code>', tag: 'data' },
        { label: '初始化 Paths', desc: '~/.magi-next/{sessions,memory,plugins,skills,state,logs}', tag: 'fn' },
        { label: '初始化 ProviderRegistry', desc: '注册所有 provider preset → 探测 API key', tag: 'fn' },
        { label: '初始化 ToolRegistry', desc: '加载内置工具 → 异步 connect MCP servers → 合并工具池', tag: 'fn' },
        { label: '初始化 SessionStore', desc: 'SQLite (sessions.db) 或 JSONL 目录', tag: 'fn' },
        { label: '分支：交互 vs Headless', desc: '有 -p → headless 单次执行；无 -p → 启动 TUI', tag: 'flow' }
      ]
    },
    {
      label: 'Headless 模式',
      desc: '<code>-p "prompt"</code> 单次执行',
      tag: 'flow',
      children: [
        { label: '读取 prompt', desc: '可来自 -p 参数 / stdin / 文件', tag: 'fn' },
        { label: '创建临时 session', desc: 'in-memory transcript', tag: 'fn' },
        { label: '调用 QueryEngine.submitMessage()', desc: '完整 agent 循环', tag: 'fn' },
        { label: '输出格式', desc: '<code>text</code>(默认) / <code>json</code> / <code>stream-json</code>', tag: 'data' },
        { label: '退出码', desc: '0=成功 1=错误 2=interrupted 130=SIGINT', tag: 'data' }
      ]
    },
    {
      label: 'TUI 启动流程',
      desc: '交互模式',
      tag: 'flow',
      children: [
        { label: '检测 TTY', desc: 'isatty(stdin) && isatty(stdout)，否则降级到 readline', tag: 'fn' },
        { label: '进入 alternate screen', desc: 'ESC[?1049h，保存原终端缓冲', tag: 'fn' },
        { label: '渲染 React App', desc: 'Ink render(<App/>) 启动主循环', tag: 'fn' },
        { label: '注册 cleanup', desc: 'process.on("SIGINT/SIGTERM/exit") → 退出 alternate screen + flush session', tag: 'fn' }
      ]
    },
    {
      label: 'Daemon / Serve 模式',
      desc: '后台 HTTP 控制面',
      tag: 'flow',
      children: [
        {
          label: '路由表',
          desc: 'Bun.serve()',
          tag: 'data',
          children: [
            { label: '<code>POST /sessions</code>', desc: '创建新会话', tag: 'fn' },
            { label: '<code>GET /sessions/:id</code>', desc: '获取 transcript', tag: 'fn' },
            { label: '<code>POST /sessions/:id/messages</code>', desc: '提交 prompt', tag: 'fn' },
            { label: '<code>GET /sessions/:id/events</code>', desc: 'SSE 流式事件', tag: 'fn' },
            { label: '<code>POST /jobs</code>', desc: '后台任务（agent 子进程）', tag: 'fn' },
            { label: '<code>GET /jobs/:id</code>', desc: '查询任务状态', tag: 'fn' },
            { label: '<code>POST /approvals/:id</code>', desc: '提交审批决定', tag: 'fn' },
            { label: '<code>GET /agents</code>', desc: '列出可用 subagent 类型', tag: 'fn' }
          ]
        },
        { label: '认证', desc: 'X-Magi-Token header，token 写入 ~/.magi-next/state/control-token', tag: 'data' }
      ]
    },
    {
      label: '完整 Slash Command 注册表 (95+)',
      desc: 'src/commands/ 目录扫描',
      tag: 'data',
      children: [
        {
          label: '🟢 会话管理',
          tag: 'tool',
          children: [
            { label: '<code>/clear</code>', desc: '清空对话', tag: 'tool' },
            { label: '<code>/compact</code>', desc: '强制压缩', tag: 'tool' },
            { label: '<code>/resume</code>', desc: '恢复会话', tag: 'tool' },
            { label: '<code>/fork</code>', desc: '会话分支', tag: 'tool' },
            { label: '<code>/rewind</code>', desc: '回退到某条消息', tag: 'tool' },
            { label: '<code>/export</code>', desc: '导出 session', tag: 'tool' },
            { label: '<code>/share</code>', desc: '生成可分享链接', tag: 'tool' },
            { label: '<code>/exit</code>', desc: '退出', tag: 'tool' },
            { label: '<code>/session</code>', desc: 'session 管理', tag: 'tool' },
            { label: '<code>/summary</code>', desc: '会话摘要', tag: 'tool' },
            { label: '<code>/thinkback</code> / <code>/thinkback-play</code>', desc: '思考回放', tag: 'tool' },
            { label: '<code>/backfill-sessions</code>', desc: '迁移历史 session', tag: 'tool' }
          ]
        },
        {
          label: '🔵 模型与配置',
          tag: 'tool',
          children: [
            { label: '<code>/model</code>', desc: '切换模型', tag: 'tool' },
            { label: '<code>/effort</code>', desc: '调整思考预算', tag: 'tool' },
            { label: '<code>/fast</code>', desc: '切换 fast mode', tag: 'tool' },
            { label: '<code>/config</code>', desc: '配置面板', tag: 'tool' },
            { label: '<code>/env</code>', desc: '环境变量管理', tag: 'tool' },
            { label: '<code>/theme</code>', desc: '主题', tag: 'tool' },
            { label: '<code>/color</code>', desc: '配色调试', tag: 'tool' },
            { label: '<code>/output-style</code>', desc: '输出样式', tag: 'tool' },
            { label: '<code>/keybindings</code>', desc: '键位查看/编辑', tag: 'tool' },
            { label: '<code>/vim</code>', desc: 'vim 输入模式', tag: 'tool' },
            { label: '<code>/voice</code>', desc: '语音输入', tag: 'tool' },
            { label: '<code>/terminalSetup</code>', desc: '终端设置', tag: 'tool' }
          ]
        },
        {
          label: '🟣 上下文 / 记忆',
          tag: 'tool',
          children: [
            { label: '<code>/memory</code>', desc: '记忆管理', tag: 'tool' },
            { label: '<code>/context</code>', desc: '上下文检视', tag: 'tool' },
            { label: '<code>/ctx_viz</code>', desc: '上下文可视化', tag: 'tool' },
            { label: '<code>/files</code>', desc: '已加载文件列表', tag: 'tool' },
            { label: '<code>/add-dir</code>', desc: '加入工作目录', tag: 'tool' },
            { label: '<code>/copy</code>', desc: '复制最近输出', tag: 'tool' },
            { label: '<code>/break-cache</code>', desc: '清缓存重新加载', tag: 'tool' },
            { label: '<code>/force-snip</code>', desc: '强制 snip 上下文', tag: 'tool' }
          ]
        },
        {
          label: '🟠 工具/任务',
          tag: 'tool',
          children: [
            { label: '<code>/agents</code>', desc: 'agent 管理', tag: 'tool' },
            { label: '<code>/agents-platform</code>', desc: 'agent 平台', tag: 'tool' },
            { label: '<code>/tasks</code>', desc: '任务列表', tag: 'tool' },
            { label: '<code>/skills</code>', desc: 'skills 管理', tag: 'tool' },
            { label: '<code>/plugin</code>', desc: 'plugin 管理', tag: 'tool' },
            { label: '<code>/reload-plugins</code>', desc: '重载 plugin', tag: 'tool' },
            { label: '<code>/hooks</code>', desc: 'hook 管理', tag: 'tool' },
            { label: '<code>/permissions</code>', desc: '权限规则', tag: 'tool' },
            { label: '<code>/sandbox-toggle</code>', desc: '沙箱开关', tag: 'tool' },
            { label: '<code>/mcp</code>', desc: 'MCP server 列表', tag: 'tool' },
            { label: '<code>/passes</code>', desc: '权限 pass', tag: 'tool' },
            { label: '<code>/peers</code>', desc: '已连接 peer 列表', tag: 'tool' },
            { label: '<code>/buddy</code>', desc: '伙伴 agent', tag: 'tool' },
            { label: '<code>/teleport</code>', desc: 'teleport 到其他 session', tag: 'tool' }
          ]
        },
        {
          label: '🔴 Plan / Diff / 代码',
          tag: 'tool',
          children: [
            { label: '<code>/plan</code> / <code>/ultraplan</code>', desc: '进入 plan 模式', tag: 'tool' },
            { label: '<code>/diff</code>', desc: '查看修改', tag: 'tool' },
            { label: '<code>/review</code>', desc: 'PR/代码 review', tag: 'tool' },
            { label: '<code>/security-review</code>', desc: '安全审查', tag: 'tool' },
            { label: '<code>/autofix-pr</code>', desc: '自动修 PR comments', tag: 'tool' },
            { label: '<code>/branch</code>', desc: '分支管理', tag: 'tool' },
            { label: '<code>/commit</code> / <code>/commit-push-pr</code>', desc: '提交流程', tag: 'tool' },
            { label: '<code>/issue</code>', desc: 'issue 查看', tag: 'tool' },
            { label: '<code>/pr_comments</code>', desc: 'PR comments', tag: 'tool' },
            { label: '<code>/subscribe-pr</code>', desc: '订阅 PR 活动', tag: 'tool' },
            { label: '<code>/perf-issue</code>', desc: '性能 issue 报告', tag: 'tool' },
            { label: '<code>/torch</code>', desc: '焚毁分支', tag: 'tool' }
          ]
        },
        {
          label: '🟡 状态/统计',
          tag: 'tool',
          children: [
            { label: '<code>/status</code>', desc: 'session 状态', tag: 'tool' },
            { label: '<code>/stats</code>', desc: '统计', tag: 'tool' },
            { label: '<code>/cost</code>', desc: '本次花费', tag: 'tool' },
            { label: '<code>/usage</code>', desc: '用量', tag: 'tool' },
            { label: '<code>/extra-usage</code>', desc: '额外用量', tag: 'tool' },
            { label: '<code>/rate-limit-options</code>', desc: '速率限制设置', tag: 'tool' },
            { label: '<code>/reset-limits</code>', desc: '重置限额', tag: 'tool' },
            { label: '<code>/mock-limits</code>', desc: 'mock 限额（测试）', tag: 'tool' },
            { label: '<code>/release-notes</code>', desc: '发版说明', tag: 'tool' },
            { label: '<code>/version</code>', desc: '版本信息', tag: 'tool' }
          ]
        },
        {
          label: '⚪ 认证/账号',
          tag: 'tool',
          children: [
            { label: '<code>/login</code> / <code>/logout</code>', tag: 'tool' },
            { label: '<code>/oauth-refresh</code>', desc: 'OAuth token 刷新', tag: 'tool' },
            { label: '<code>/onboarding</code>', desc: '新手引导', tag: 'tool' },
            { label: '<code>/install</code> / <code>/upgrade</code>', desc: '更新 CLI', tag: 'tool' },
            { label: '<code>/privacy-settings</code>', desc: '隐私设置', tag: 'tool' },
            { label: '<code>/feedback</code>', desc: '提交反馈', tag: 'tool' }
          ]
        },
        {
          label: '🟤 高级/实验',
          tag: 'tool',
          children: [
            { label: '<code>/bridge</code> / <code>/bridge-kick</code>', desc: '远程桥接', tag: 'tool' },
            { label: '<code>/remoteControlServer</code>', desc: '远程控制服务器', tag: 'tool' },
            { label: '<code>/remote-env</code> / <code>/remote-setup</code>', desc: '远程环境', tag: 'tool' },
            { label: '<code>/desktop</code>', desc: '桌面集成', tag: 'tool' },
            { label: '<code>/mobile</code>', desc: '移动端', tag: 'tool' },
            { label: '<code>/chrome</code>', desc: 'Chrome 扩展', tag: 'tool' },
            { label: '<code>/ide</code>', desc: 'IDE 集成', tag: 'tool' },
            { label: '<code>/workflows</code>', desc: '工作流', tag: 'tool' },
            { label: '<code>/desktop</code>', desc: '桌面 app', tag: 'tool' },
            { label: '<code>/heapdump</code>', desc: '堆转储调试', tag: 'tool' },
            { label: '<code>/debug-tool-call</code>', desc: '工具调用调试', tag: 'tool' },
            { label: '<code>/ant-trace</code>', desc: '内部 trace（蚂蚁金服遗留命名）', tag: 'tool' },
            { label: '<code>/btw</code>', desc: 'by the way 旁注', tag: 'tool' },
            { label: '<code>/bughunter</code>', desc: 'bug 猎手', tag: 'tool' },
            { label: '<code>/good-claude</code>', desc: '点赞当前回复', tag: 'tool' },
            { label: '<code>/tag</code>', desc: '标签', tag: 'tool' },
            { label: '<code>/rename</code>', desc: '重命名 session', tag: 'tool' },
            { label: '<code>/proactive</code>', desc: '主动建议模式', tag: 'tool' },
            { label: '<code>/advisor</code>', desc: '顾问模式', tag: 'tool' },
            { label: '<code>/brief</code>', desc: '简报', tag: 'tool' },
            { label: '<code>/stickers</code>', desc: '贴纸表情', tag: 'tool' },
            { label: '<code>/help</code> / <code>/doctor</code>', desc: '帮助和诊断', tag: 'tool' }
          ]
        }
      ]
    },
    {
      label: 'Ablation Baseline 模式',
      desc: 'CLAUDE_CODE_ABLATION_BASELINE 环境变量',
      tag: 'data',
      children: [
        { label: '强制 CLAUDE_CODE_SIMPLE=1', desc: '关闭简化模式', tag: 'state' },
        { label: '强制 CLAUDE_CODE_DISABLE_THINKING=1', desc: '禁用 extended thinking', tag: 'state' },
        { label: '强制 DISABLE_INTERLEAVED_THINKING=1', desc: '禁用交错思考', tag: 'state' },
        { label: '强制 DISABLE_COMPACT=1', desc: '禁用压缩', tag: 'state' },
        { label: '强制 DISABLE_AUTO_COMPACT=1', desc: '禁用自动压缩', tag: 'state' },
        { label: '强制 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1', desc: '禁用自动记忆', tag: 'state' },
        { label: '强制 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1', desc: '禁用后台任务', tag: 'state' }
      ]
    },
    {
      label: '其他 Fast Path 入口',
      desc: '不进入 React 渲染',
      tag: 'flow',
      children: [
        { label: '<code>--dump-system-prompt</code>', desc: 'Ant-only，输出系统提示', tag: 'fn' },
        { label: '<code>--claude-in-chrome-mcp</code>', desc: 'Chrome 扩展 MCP server', tag: 'fn' },
        { label: '<code>--chrome-native-host</code>', desc: 'Chrome native messaging', tag: 'fn' },
        { label: '<code>--computer-use-mcp</code>', desc: 'Computer Use MCP server', tag: 'fn' },
        { label: '<code>--daemon-worker &lt;kind&gt;</code>', desc: '由 supervisor spawn 的内部 worker', tag: 'fn' },
        { label: '<code>remote-control / rc / sync / bridge</code>', desc: 'BRIDGE_MODE 桥接', tag: 'fn' },
        { label: '<code>daemon</code>', desc: 'DAEMON 守护进程子命令', tag: 'fn' },
        { label: '<code>ps / logs / attach / kill</code>', desc: 'BG_SESSIONS 后台 session 管理', tag: 'fn' },
        { label: '<code>--bg / --background</code>', desc: '后台模式启动', tag: 'fn' },
        { label: '<code>new / list / reply</code>', desc: 'TEMPLATES 模板任务', tag: 'fn' },
        { label: '<code>environment-runner</code>', desc: 'BYOC 环境 runner', tag: 'fn' },
        { label: '<code>self-hosted-runner</code>', desc: '自托管 runner', tag: 'fn' },
        { label: '<code>--worktree --tmux</code>', desc: '完整 CLI 加载前 exec 进 tmux', tag: 'fn' },
        { label: '<code>--bare</code>', desc: 'CLAUDE_CODE_SIMPLE=1 极简模式', tag: 'fn' }
      ]
    }
  ]
};

// === MIND_MAP — 必须在所有 *Tree 之后 ===
const MIND_MAP = {
  modules: [
    { id: 'cli',      title: 'CLI 入口',         icon: '⌨',  color: '#f97583', summary: 'magi-agent 的命令行入口，负责参数解析、快速路径分流、TUI 启动、守护进程模式。', tree: cliTree },
    { id: 'loop',     title: '核心 Agent 循环',   icon: '⟳',  color: '#79c0ff', summary: '系统的心脏。query() 异步生成器实现 prompt → model → tools → loop 状态机，配合 StreamingToolExecutor 实现流式工具执行。', tree: loopTree },
    { id: 'tools',    title: '工具系统',         icon: '🔧', color: '#7ee787', summary: '60+ 内置工具 + MCP 动态工具。统一的 Tool 接口（Zod schema、permission、并发安全标记），分发器根据 isConcurrencySafe 并行/串行执行。', tree: toolsTree },
    { id: 'provider', title: 'Provider 路由',    icon: '🌐', color: '#d2a8ff', summary: 'Preset 化的多 provider 适配 + Anthropic/OpenAI 格式互转 Proxy + 智能路由（任务分类 + 模型评分 + Fallback 链）。', tree: providerTree },
    { id: 'memory',   title: '记忆与上下文',     icon: '🧠', color: '#ffa657', summary: '6 层上下文构建（系统/项目/记忆/动态/Git/日期）+ Sonnet 选记忆 + microcompact + LLM summarize 两阶段压缩。', tree: memoryTree },
    { id: 'session',  title: '会话/Hooks/Skills/Plugins', icon: '💾', color: '#56d4dd', summary: 'JSONL 会话持久化 + 9 种 Hook 事件 × 4 种 Hook 类型 + Skill 系统 + Plugin marketplace。', tree: sessionTree },
    { id: 'mcp',      title: 'MCP 客户端',       icon: '🔌', color: '#ff7b72', summary: '4 种传输（stdio/SSE/HTTP/WebSocket），工具/资源发现，审批流程（never/always/dangerous），连接生命周期管理。', tree: mcpTree },
    { id: 'tui',      title: 'TUI 系统',         icon: '🖥', color: '#d4a5ff', summary: 'React + Ink 全屏 TUI，覆盖层系统（Diff/Approval/Picker），流式渲染，键盘快捷键，Slash Command。', tree: tuiTree },
    { id: 'agent',    title: '子 Agent 系统',    icon: '🤖', color: '#a5d6ff', summary: 'AgentTool 启动子 agent，支持 worktree 隔离 / 远程会话 / 后台运行；Coordinator 模式调度多 worker；XML task-notification 协议。', tree: agentTree }
  ]
};
