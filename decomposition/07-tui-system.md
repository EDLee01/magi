# 07 — 终端 UI 系统

## 架构选择

```
Legacy: React + Ink (自定义 fork) → 全屏 TUI
Magi-Next 目标: 同样用 React + Ink 或等价方案

核心组件:
- 全屏模式 (alternate screen buffer)
- 输入区 (prompt)
- 输出区 (transcript, 可滚动)
- 覆盖层 (diff 审批, 权限确认)
- 状态栏 (model, session, cost)
```

## 主界面布局

```
┌─────────────────────────────────────────────┐
│ [状态栏] model: claude-sonnet | session: abc │
├─────────────────────────────────────────────┤
│                                             │
│  Transcript (可滚动)                         │
│                                             │
│  > user: 帮我写个函数                        │
│                                             │
│  assistant: 好的，让我...                    │
│  [tool: FileWrite src/utils.ts]             │
│  [tool: Bash npm test]                      │
│                                             │
│  assistant: 完成了，测试通过。               │
│                                             │
├─────────────────────────────────────────────┤
│ > [输入区]                                   │
│   type / for commands, Ctrl+C to exit       │
└─────────────────────────────────────────────┘
```

## 输入处理

```
FUNCTION handleInput(key, state) -> Action:
  # Slash commands
  IF state.input.startsWith("/"):
    suggestions = filterSlashCommands(state.input)
    showSuggestionOverlay(suggestions)
    RETURN

  # 特殊键
  SWITCH key:
    CASE "Enter":
      IF state.input.trim():
        submitPrompt(state.input)
        state.input = ""
    CASE "Ctrl+C":
      IF state.isRunning:
        interrupt()  # 中断当前 agent 循环
      ELSE:
        exit()
    CASE "Ctrl+Up":
      scrollTranscript("up")
    CASE "Ctrl+Down":
      scrollTranscript("down")
    CASE "Up":
      state.input = previousHistory()
    CASE "Tab":
      autocomplete(state.input)
    CASE "Escape":
      closeOverlay()
```

## 流式输出渲染

```
FUNCTION renderStreamingResponse(stream):
  buffer = ""

  FOR EACH event IN stream:
    SWITCH event.type:
      CASE "text_delta":
        buffer += event.text
        renderMarkdown(buffer)  # 实时渲染 markdown

      CASE "tool_use_start":
        showToolSpinner(event.toolName, event.description)

      CASE "tool_result":
        hideToolSpinner()
        renderToolResult(event)

      CASE "usage":
        updateStatusBar({ tokens: event.usage })

      CASE "error":
        renderError(event.error)

      CASE "approval_request":
        decision = AWAIT showApprovalDialog(event)
        SEND decision BACK
```

## Diff 审批 UI

```
FUNCTION showDiffApproval(toolCall) -> boolean:
  """
  当 FileEdit/FileWrite 需要审批时显示
  """
  diff = toolCall.result.diff
  hunks = parseDiff(diff)

  # 渲染 overlay
  overlay = {
    title: "File change: " + toolCall.input.file_path,
    content: renderDiffHunks(hunks),
    actions: [
      { key: "y", label: "Approve" },
      { key: "n", label: "Reject" },
      { key: "d", label: "Show full diff" }
    ]
  }

  showOverlay(overlay)
  key = AWAIT waitForKey()

  SWITCH key:
    CASE "y", "Enter": RETURN true
    CASE "n", "Escape": RETURN false
    CASE "d":
      showFullDiff(diff)
      RETURN AWAIT showDiffApproval(toolCall)  # 递归

FUNCTION renderDiffHunks(hunks):
  FOR hunk IN hunks:
    print(dim("@@ " + hunk.header + " @@"))
    FOR line IN hunk.lines:
      IF line.startsWith("+"):
        print(green(line))
      ELSE IF line.startsWith("-"):
        print(red(line))
      ELSE:
        print(dim(line))
```

## 工具执行显示

```
FUNCTION showToolSpinner(toolName, description):
  """
  工具执行时显示 spinner + 描述
  """
  spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  frame = 0

  interval = setInterval(() => {
    clearLine()
    print(dim(spinnerFrames[frame % 10] + " " + description))
    frame++
  }, 80)

  RETURN { stop: () => clearInterval(interval) }

FUNCTION renderToolResult(event):
  SWITCH event.toolName:
    CASE "Bash":
      IF event.result.exitCode == 0:
        print(dim("$ " + event.input.command))
        IF event.result.stdout:
          print(event.result.stdout.slice(0, 500))
      ELSE:
        print(red("$ " + event.input.command + " (exit " + event.result.exitCode + ")"))
        print(red(event.result.stderr))

    CASE "FileRead":
      print(dim("Read " + event.input.file_path + " (" + event.result.lineCount + " lines)"))

    CASE "FileEdit", "FileWrite":
      print(dim("Wrote " + event.input.file_path))
      renderCompactDiff(event.result.diff)

    CASE "Grep":
      print(dim("Search: " + event.input.pattern + " → " + event.result.numFiles + " files"))
```

## Slash Command 系统

```
SLASH_COMMANDS = [
  { name: "help",     description: "Show commands" },
  { name: "model",    description: "Switch model", args: "[alias]" },
  { name: "status",   description: "Show session status" },
  { name: "memory",   description: "View memory" },
  { name: "sessions", description: "List sessions" },
  { name: "resume",   description: "Resume session", args: "[id|query]" },
  { name: "compact",  description: "Force context compaction" },
  { name: "clear",    description: "Clear conversation" },
  { name: "diff",     description: "Show current changes" },
  { name: "exit",     description: "Exit" },
]

FUNCTION handleSlashCommand(input):
  [name, ...args] = input.slice(1).split(" ")
  command = SLASH_COMMANDS.find(c => c.name == name)

  IF NOT command:
    showError("Unknown command: /" + name)
    RETURN

  SWITCH name:
    CASE "model":
      IF args[0]:
        setCurrentModel(args[0])
        showInfo("Model: " + args[0])
      ELSE:
        showModelList()
    CASE "resume":
      sessions = searchSessions(args.join(" "))
      showSessionPicker(sessions)
    CASE "compact":
      compactCurrentSession()
      showInfo("Context compacted")
    CASE "clear":
      clearConversation()
    CASE "diff":
      showDiffOverlay(getCurrentDiff())
```

## 与 magi-next 的差距

当前 magi-next 有:
- ✅ 基础 readline REPL (tui.ts)
- ✅ Slash commands 解析和执行
- ✅ Session 列表/恢复

缺失:
- ❌ 全屏模式 (alternate screen)
- ❌ 流式输出渲染
- ❌ Markdown 渲染
- ❌ Diff 审批 overlay
- ❌ 工具执行 spinner
- ❌ 滚动 transcript
- ❌ 键盘快捷键系统
- ❌ 状态栏
- ❌ 自动补全

## 推荐实现路径

1. **Phase 1**: 保持 readline，加入流式输出 + 基础 markdown
2. **Phase 2**: 引入 Ink 或 blessed，实现全屏 + 滚动
3. **Phase 3**: Diff overlay + 权限确认 UI
4. **Phase 4**: 状态栏 + 快捷键 + 自动补全
