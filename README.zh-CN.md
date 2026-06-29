# Magi

[English](README.md)

**住在终端里的编程助手 — 跑在你自己的机器上。**

Magi 能读仓库、改文件、跑命令、搜网页，并且记住上次做到哪。一次会话可以横跨本机、局域网里的另一台电脑，以及手机浏览器上的审批界面。代码留在本地，模型和 Key 由你自己提供。

```
$ magi
  △   Magi · 91 tools
 /✦\  cwd: ~/code/my-project
▔▔▔   model: main · claude-sonnet-4-6

  /help for commands · Ctrl+C to interrupt · /exit to quit

> refactor src/auth.ts to use the new session API
```

---

## 为什么用 Magi

很多 Agent 绑在 IDE 里，或者关掉窗口就什么都没了。Magi 面向习惯用 Shell 的开发者：像基础设施一样常驻、可脚本化、可控。

| | |
|---|---|
| **改得准** | `FilePatch` 按上下文精确打补丁，多行改动落在该落的位置，不是整文件覆盖。 |
| **记得住** | 持久 Memory、会话召回、可审核的 LearningDraft — 项目惯例和过往决策不会每次从零开始。 |
| **先计划再动手** | Plan 模式在方案确认前阻止危险编辑，适合重构、迁移和不敢 YOLO 的任务。 |
| **一台不够就多台** | 局域网发现 Magi 守护进程、向 peer 派发子 Agent、在手机上审批工具调用 — 同一套会话模型。 |
| **模型随你选** | Anthropic、OpenAI、DeepSeek 或任意兼容端点；`fast` / `main` / `deep` 别名，或 `/model auto` 按任务自动选。 |

---

## 能做什么

**日常开发** — 修 bug、写测试、解释陌生代码、跑测试、生成合理的 commit message。

**正经重构** — 跨文件改名、迁移 API、更新类型；Plan 模式先对齐方案再改代码。

**查资料与调试** — 联网搜索、抓取 URL、搜仓库、看 git 历史，同时挂一个后台 Agent 继续干活。

**多机协作** — 对比两台机器上的仓库、在构建机上跑检查、通过手机 LAN 面板审批（类似推送通知的体验）。

**扩展** — 接入 MCP、从 GitHub 安装 Skill、自己写 `SKILL.md` 工作流。

---

## 快速开始

```sh
git clone https://github.com/EDLee01/magi.git
cd magi
npm install && npm run build && npm link

export OPENAI_API_KEY="<your-key>"
# 或: export ANTHROPIC_AUTH_TOKEN="<your-key>"
# 或: export DEEPSEEK_API_KEY="<your-key>"

magi init          # 生成 ~/.magi-next/config.yaml
magi               # 交互界面
magi -p "explain this repo"   # 单次提问
```

还没配 Key？运行 `magi init` 会提示该设哪个环境变量。

**第一次用：** `magi tutorial` — 八个短章节，涵盖模型、文件、记忆、Skill 和多机设置。

---

## 核心能力（值得知道的）

**Agent 循环** — 并行工具调用、流式输出、模型不可用或限流时自动 fallback。

**91 个内置工具** — 文件、Shell、Git、Web、定时任务、子 Agent 等；重型工具通过 `ToolSearch` 按需加载，首回合保持轻量。

**Skills** — 内置 `verify`、`debug`、`stuck`、`commit-msg`、`review-pr` 等工作流；也可用 `magi skill install` 安装更多。

**会话** — SQLite 持久化；`magi sessions`、`magi resume`，上下文过长时用 `/compact`。

**Control API** — `magi daemon start` + `magi pair` 暴露局域网 Web 面板，手机审批、后台任务。

**Peers** — `magi peers` 发现局域网内的 Magi；Agent 用 `target: "peer-name"` 派发到远程机器。

---

## 常用命令

| 命令 | 作用 |
|------|------|
| `magi` | 交互界面 |
| `magi -p "<prompt>"` | 单次提问 |
| `magi init` | 配置 Provider 和模型 |
| `magi doctor` | 检查配置路径与健康状态 |
| `magi sessions` / `magi resume <id>` | 浏览并继续历史会话 |
| `magi daemon start` | 后台 Control API |
| `magi pair <name>` | 配对手机或远程客户端 |
| `magi peers` | 发现局域网守护进程 |
| `magi memory search <q>` | 搜索持久 Memory |
| `magi learning list` | 查看待审核的 LearningDraft |
| `magi tutorial` | 引导教程 |

交互界面内：`/help`、`/model auto`、`/compact`、`/plan`。

---

## 配置示例

配置文件：`~/.magi-next/config.yaml`（也可直接 `magi init` 跳过手写）。

```yaml
providers:
  anthropic:
    type: messages-compatible
    format: anthropic-messages
    apiKeyEnv: ANTHROPIC_AUTH_TOKEN
    baseUrl: https://api.anthropic.com

models:
  aliases:
    fast: anthropic:claude-haiku-4-5
    main: anthropic:claude-sonnet-4-6
    deep:  anthropic:claude-opus-4-7
  router:   # alias 为 auto 时使用
    fast:  { family: claude, role: haiku,  contextWindow: 200000 }
    main:  { family: claude, role: sonnet, contextWindow: 200000 }
    deep:  { family: claude, role: opus,   contextWindow: 200000 }
```

开箱支持 OpenAI、Anthropic、DeepSeek。

---

## 手机与多机（30 秒）

```sh
# 每台机器：
MAGI_CONTROL_BIND=0.0.0.0 magi daemon start

# 配对手机：
magi pair my-phone
# → 同一 Wi‑Fi 下打开 /panel URL，输入 Device ID + Token

# 查看局域网 peer：
magi peers
```

远程子 Agent 与本地工具共用同一套会话和审批模型。

---

## 文件在哪

```
~/.magi-next/
  config.yaml              # Provider 与模型
  state/sessions.sqlite    # 会话、任务、审计
  memory/                  # 持久 Memory
  skills/                  # 已安装 Skill
  state/learning-drafts/  # 待审核的学习草稿（apply 后生效）
```

测试或 CI 可用 `MAGI_CONFIG_DIR` 覆盖根目录。

---

## 更多文档

| 文档 | 内容 |
|------|------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 组件、会话、工具、路由 |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 常见错误 |
| [docs/magi-next-learning-loop-v1.html](docs/magi-next-learning-loop-v1.html) | Memory 与学习循环设计 |
| `magi tutorial` | 交互式入门 |

**开发者：** 回归测试见 `npm test`、`npm run verify`；Memory / Patch / Goal 等 eval 脚本在 `package.json` 中。

---

## 构建要求

Node **≥ 22**。Rust 可选（runner 侧车，用于 sandbox/PTY）。

```sh
npm install && npm run build && npm test
```

---

## 状态

**v0.1.13** — 持续开发中。Agent 循环、路由、MCP、守护进程、多机派发和手机面板已实现并有测试覆盖。Beta 阶段，CLI 与配置可能仍有变动。

反馈问题时请附上 `magi doctor` 和 `magi --version` 的输出。

MIT License。
