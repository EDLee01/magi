# Magi（HotAITool 版）

## 简介

Magi 是一款运行在终端中的 AI 编程助手，支持阅读与修改代码、执行命令、检索项目上下文等能力，适用于日常开发与代码排查场景。

本文档介绍 **HotAITool 版**：在 Magi 基础上，预置了 HotAITool 网关地址与模型路由，使用者只需配置 API Key 即可开始工作。该版本与公开发行的 Magi 相互独立——启动命令、配置文件路径均不相同，在同一台机器上并存使用时不会相互覆盖。

| 项目 | 公开发行版 | HotAITool 版 |
|------|-----------|--------------|
| 启动命令 | `magi` | `magi-hotaitool` |
| 配置目录 | `~/.magi-next` | `~/.magi-hotaitool` |

---

## 环境要求

- Node.js 20 及以上
- 可访问 HotAITool 网关的网络环境
- 有效的 HotAITool API Key

---

## 安装步骤

从仓库获取代码并切换至 `hotai` 分支：

```sh
git clone https://github.com/EDLee01/magi.git
cd magi
git checkout hotai
```

安装主程序与 HotAITool 版入口：

```sh
npm install && npm run build && npm link

cd editions/hotaitool
npm install && npm run build && npm link
```

安装完成后，可在终端中执行 `magi-hotaitool` 命令。

---

## 配置说明

### 1. 初始化

```sh
magi-hotaitool setup
```

上述命令将在 `~/.magi-hotaitool/` 目录下创建配置文件。首次运行会生成 `provider.env` 模板。

### 2. 填写 API Key

编辑 `~/.magi-hotaitool/provider.env`，填入以下内容：

```bash
ANTHROPIC_AUTH_TOKEN=您的密钥
ANTHROPIC_BASE_URL=https://www.hotaitool.net

OPENAI_API_KEY=您的密钥
OPENAI_BASE_URL=https://www.hotaitool.net/v1
```

说明：

- Claude 与 GPT 通常可使用同一密钥；若仅使用其中一种模型，填写对应部分即可。
- 网关地址须严格按上表填写（详见下文「网关地址说明」）。

### 3. 生成运行配置

再次执行：

```sh
magi-hotaitool setup
```

系统将依据已填写的密钥生成 `config.yaml`。可通过以下命令检查配置是否生效：

```sh
magi-hotaitool doctor
```

---

## 网关地址说明

HotAITool 对 Claude 与 GPT 采用不同的 API 路径，配置时请注意区分：

| 模型类型 | 环境变量 | 网关地址 |
|---------|---------|---------|
| Claude | `ANTHROPIC_BASE_URL` | `https://www.hotaitool.net`（不含 `/v1`） |
| GPT | `OPENAI_BASE_URL` | `https://www.hotaitool.net/v1`（含 `/v1`） |

地址填写错误时，可能出现 HTTP 404，或返回网页内容而非模型响应。

---

## 使用方法

**单次提问：**

```sh
magi-hotaitool -p "请简要说明本项目的目录结构"
```

**交互模式（推荐日常使用）：**

```sh
magi-hotaitool
```

进入交互界面后，以自然语言描述任务即可。常用操作：

- 输入 `/help` 查看命令列表
- 输入 `/model fast`、`/model main`、`/model deep` 切换模型档位
- 输入 `/exit` 退出

---

## 默认模型

系统为 fast / main / deep 三个档位预置了如下模型（Claude 密钥可用时优先走 Claude 线路）：

| 档位 | Claude 可用 | 仅 GPT 密钥 |
|------|------------|------------|
| fast | claude-haiku-4-5 | gpt-5-mini |
| main | claude-sonnet-4-6 | gpt-5.5 |
| deep | claude-opus-4-7 | gpt-5.5-codex-max |

---

## 配置文件位置

```
~/.magi-hotaitool/
├── provider.env    # API Key 与网关地址
└── config.yaml     # 模型与路由配置（由 setup 自动生成）
```

如需更改配置目录，可设置环境变量 `MAGI_HOTAITOOL_CONFIG_DIR`。

---

## 常见问题

**与公开发行版 Magi 有何区别？**  
功能一致。HotAITool 版预置了网关与模型配置，并使用独立的配置目录。

**代码更新后是否需要重新安装？**  
需要在仓库根目录及 `editions/hotaitool` 目录下分别执行 `npm run build`。

**遇到配置或连接问题如何处理？**  
请先运行 `magi-hotaitool doctor`，将输出信息提供给维护人员以便排查。
