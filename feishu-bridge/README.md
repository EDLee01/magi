# Feishu Bridge (Magi 集群遥控)

飞书长连接 → 路由 Magi (Mac mini) → 集群执行 → 结果推回飞书。

## 前置条件

1. **飞书开放平台**（open.feishu.cn）
   - 企业自建应用，开启「机器人」
   - 权限：`im:message`、`im:message:send_as_bot`（后续图片加 `im:resource`）
   - 事件订阅：**长连接模式**，订阅 `im.message.receive_v1`
   - 发布应用（开发版即可在测试企业内使用）

2. **Mac mini 路由机**
   ```bash
   export MAGI_CONFIG_DIR=~/.magi-router   # 示例
   magi serve                               # 默认 :8765
   magi pair feishu-bridge                 # 拿到 device_id + token
   ```

3. **本 bridge 配置**
   ```bash
   cp config.example.toml config.local.toml
   # 填入 app_id / app_secret / router token / allowed_user_ids
   ```

## 运行

```bash
cd feishu-bridge
chmod +x scripts/run.sh
./scripts/run.sh
```

看到 `connected to wss://...` 即长连接成功。

## 白名单

在飞书里给 bot 发一条消息后，从 bridge 日志或飞书开放平台调试里拿到你的 **open_id**，写入：

```toml
[security]
allowed_user_ids = ["ou_xxxxxxxx"]
```

## MVP 命令

| 飞书消息 | 行为 |
|---------|------|
| `节点状态` | 探测 router + config 里 manual peers 的 `/health` |
| 任意自然语言 | 经 router `POST /jobs` 投递 Magi 任务（需已 pair） |

## 安全

- `config.local.toml` 已在 `.gitignore`，**勿提交** App Secret。
- 含 `rm -rf`、`sudo`、`drop table` 等模式的指令会被拦截。
- 危险操作二次确认（卡片按钮）在 Step 4 接入 Magi approvals API。

## 单机模拟集群

配合 `magi-sim-cluster.sh` 起 8765–8768 四实例，在 `config.local.toml` 的 `[[peers.manual]]` 填好地址即可用「节点状态」验证。
