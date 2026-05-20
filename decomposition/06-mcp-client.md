# 06 — MCP 客户端

## 传输层

```
ENUM McpTransport:
  stdio    # 本地子进程 (stdin/stdout)
  sse      # HTTP Server-Sent Events
  http     # Streamable HTTP
  websocket # WebSocket 双向

# 最常用: stdio（本地工具）
FUNCTION connectStdio(config: McpServerConfig) -> McpConnection:
  process = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ["pipe", "pipe", "pipe"]
  })

  transport = new StdioTransport(process.stdin, process.stdout)
  client = new McpClient(transport)
  AWAIT client.initialize()

  RETURN { client, process, transport }
```

## 工具发现

```
FUNCTION discoverMcpTools(client, serverName) -> McpToolDefinition[]:
  response = AWAIT client.request("tools/list", {})

  RETURN response.tools.map(tool => ({
    name: "mcp__" + serverName + "__" + tool.name,  # 命名空间
    description: truncate(tool.description, 2048),
    inputSchema: tool.inputSchema,
    serverName,
    originalName: tool.name
  }))
```

## 工具执行

```
FUNCTION executeMcpTool(client, toolName, input) -> ToolResult:
  TRY:
    response = AWAIT client.request("tools/call", {
      name: toolName,
      arguments: input
    })

    # 格式化结果
    IF response.content:
      text = response.content
        .filter(c => c.type == "text")
        .map(c => c.text)
        .join("\n")
      RETURN { output: text }

    RETURN { output: JSON.stringify(response) }

  CATCH error:
    IF error.code == -32001:  # Session expired
      AWAIT reconnect(client)
      RETURN executeMcpTool(client, toolName, input)  # 重试

    IF error.code == -32042:  # Needs retry (auth)
      RETURN { error: "MCP auth required", retryable: true }

    THROW error
```

## 审批流程

```
FUNCTION checkMcpApproval(serverConfig, toolCall) -> "allow" | "ask" | "deny":
  SWITCH serverConfig.approval:
    CASE "never":     RETURN "allow"   # 永不询问
    CASE "always":    RETURN "ask"     # 总是询问
    CASE "dangerous": # 默认：只对危险操作询问
      IF isMcpToolDangerous(toolCall):
        RETURN "ask"
      RETURN "allow"

FUNCTION isMcpToolDangerous(toolCall) -> boolean:
  # 基于工具名称和参数的启发式判断
  dangerousPatterns = ["write", "delete", "execute", "run", "modify"]
  RETURN dangerousPatterns.some(p => toolCall.name.includes(p))
```

## MCP 资源

```
# MCP 服务器也可以暴露"资源"（类似文件）
FUNCTION listMcpResources(client) -> McpResource[]:
  response = AWAIT client.request("resources/list", {})
  RETURN response.resources

FUNCTION readMcpResource(client, uri) -> string:
  response = AWAIT client.request("resources/read", { uri })
  RETURN response.contents[0].text
```

## 生命周期管理

```
CLASS McpConnectionManager:
  connections: Map<serverName, McpConnection>

  ASYNC FUNCTION connect(serverName, config):
    IF connections.has(serverName):
      RETURN connections.get(serverName)

    connection = AWAIT connectStdio(config)
    connections.set(serverName, connection)

    # 监听进程退出
    connection.process.on("exit", () => {
      connections.delete(serverName)
    })

    RETURN connection

  ASYNC FUNCTION disconnectAll():
    FOR [name, conn] IN connections:
      conn.process.kill()
    connections.clear()

  FUNCTION getTools() -> McpToolDefinition[]:
    allTools = []
    FOR [name, conn] IN connections:
      tools = AWAIT discoverMcpTools(conn.client, name)
      allTools.PUSH(...tools)
    RETURN allTools
```

## 与 magi-next 的差距

当前 magi-next 有:
- ✅ McpClient 基础实现 (stdio transport)
- ✅ initialize() + listTools()
- ✅ 配置加载 (config.yaml mcp.servers)

缺失:
- ❌ tools/call 执行
- ❌ 集成到 agent 循环的工具池
- ❌ 审批流程
- ❌ 资源发现/读取
- ❌ 连接管理器（多 server 生命周期）
- ❌ Session 过期重连
