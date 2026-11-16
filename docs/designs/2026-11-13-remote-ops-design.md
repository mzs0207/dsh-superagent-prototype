# Detailed Design: 多环境 SSH / Docker Compose 排障

## 1. 目标与上下文

当前项目是 TypeScript / Cordis 的 DSH bundle，现有工具通过 `ctx.tools.register` 注册；worker 有工具白名单。当前安装的第三方 `dsh-remote` 适合 SSH 登录、远程工作区和终端，但 Compose 项目不是其机器模型的一部分，切换工作区也不适合一次检查多台机器。

采用独立的 `dsh-superagent/remote-ops` 原生插件，不改 DSH 核心，不依赖第三方插件的内部服务，不切换 workspace。插件使用本机 OpenSSH，复用 SSH config、密钥、agent 和 ProxyJump。首版明确不支持直接传密码；需要密码或交互式终端时继续使用 dsh-remote。

## 2. 范围与安全边界

- 环境可任意命名、设置中文别名，包含一台或多台服务器；每台配置多个 Compose 项目。
- 仅提供固定只读诊断动作：Compose 状态、有限日志、镜像、进程、服务名，以及主机容器/资源/Docker 版本。
- 不提供任意 shell、exec、restart、up/down、pull、部署、sudo 交互或完整 Compose config/env 输出。
- 生产标记用于识别目标；所有环境使用相同的只读动作白名单，不能把工具白名单视为 SSH 账号权限隔离。Docker 组本身近似 root 权限，应使用独立诊断账号/受限 SSH 命令。
- 强制校验 host key，BatchMode，禁止 agent/X11 转发、local command、SSH 复用和持久转发。首次信任服务器由操作者经可信渠道核对指纹。
- 所有参数先验证，远端参数使用 POSIX 单引号转义，本地使用 spawn argv、不经过 shell。
- 超时、取消、输出上限、跨请求并发限制；逐台执行，失败不隐瞒、不自动转移到其他环境。
- 日志可能包含业务敏感信息；采集结果会进入 DSH 会话，不声称自动脱敏。

## 3. 模块与接口

### inventory.ts

`InventorySchema` 验证本地 JSON 台账；`readInventory(path)` 限制文件大小并动态读取，每次调用重新解析，不修改台账。

结构：`{ version: 1, environments: [{ id, label?, aliases?: [], production?: false, servers: [{ id, label?, host, port?, user?, identityFile?, sudo?: false, projects: [{ id, label?, directory, files?: [], projectName?, profiles?: [] }] }] }] }`。

id 在各自集合唯一；环境 id/label/alias 规范化后全局唯一，防止中文名称解析到错误环境。路径目录必须为远端绝对路径；本地 identityFile 为绝对路径或 ~/；Compose files 为不含控制字符的相对或绝对路径。字段严格校验，拒绝 password、未知字段和 shell 命令字段。

`resolveEnvironment(inventory, selector)` 精确匹配规范化的 id/label/alias；没有默认环境。`inventoryView` 仅公开环境、服务器和项目标识/描述，不返回认证路径、地址或任何密码。

### commands.ts

`InspectSchema`：environment 必填；server/project 可选；action 枚举；services 数组、tail(1..1000，默认100)、since（例如 30m/2h 或 RFC3339，可选）。日志以外动作不能使用日志参数，主机动作不允许 project/services。

`planInspection(inventory, request)` 在启动任何进程前解析环境、服务器和项目；未指定 project 时每台必须恰好有一个项目，禁止猜测；任一目标不合法则整批拒绝。主机动作无项目要求。

`sshInvocation(target, request)` 返回 `{ executable: 'ssh', args }`。命令集合：

- status: `docker compose ... ps --all --format json`
- logs: `docker compose ... logs --no-color --timestamps --tail N [--since value] [services]`
- images: `docker compose ... images`
- top: `docker compose ... top [services]`
- services: `docker compose ... config --services`
- containers: `docker ps --all --no-trunc`
- resources: 固定的 `uname -a; uptime; df -h; free -m`（各项退出码标注）
- docker_version: `docker version` 和 `docker compose version`（各项退出码标注）

Compose 文件按数组顺序传入，多文件覆盖；未指定 files 则使用 Compose 默认发现。sudo 为操作者台账字段，仅固定 `sudo -n docker`。

### runner.ts

`runSsh(invocation, signal, limits)`：流式收集 stdout/stderr，总量有上限；超过后继续排空但不缓存，返回 truncated。超时/取消杀死本地 SSH 进程并等待 close；远端断线不保证远程进程立即死亡，因此不允许长期 follow。按原始字节分别缓存 stdout/stderr，进程关闭后拼接解码 UTF-8，避免正常分块拆坏字符；若恰在多字节字符中间达到输出上限，截断边缘可能显示替代字符。

`RemoteOps.inspect(request, signal)`：加载台账并预校验，单次请求逐台检查，使用服务级 semaphore 限制全局 SSH 并发。合并调用 signal 与插件 lifetime。每台返回目标标识、action、exitCode/signal、耗时、stdout/stderr、truncated/timedOut/error；失败不阻断其他服务器，取消停止后续服务器。返回整体 ok 标记，不能用成功服务器掩盖其他失败。

### index.ts

插件 Config：inventoryFile（空表示未配置）、timeoutSeconds（默认30，最多120）、maxOutputBytes（默认65536）、maxConcurrent（默认2）。注册 `remote_ops_inventory` 与 `remote_ops_inspect`，output 为 JSON。生命周期释放注册、取消所有 SSH 并等待结束。无需管理 HTTP 路由或新增前端构建。

插件 bundle 默认挂载但台账为空，不会启动 SSH。注册工具可用于普通 DSH 会话；worker 白名单加入工具名，仍受工单存活 guard 保护。主 Session 保持路由职责，不开放诊断工具。

## 4. 调用流与复杂度

用户明确环境 → inventory 精确解析 → 预验证全部目标 → 等待共享并发槽 → 每机一次 SSH 固定命令 → 按机返回证据。预校验 O(台账大小 + 目标机数 × 所选环境大小)，包括每次生成 SSH argv 的防御性重验证；远程执行 O(目标机数)，单个进程缓存 O(maxOutputBytes)，不重试、不自动改目标。

## 5. 错误与恢复

| 场景 | 行为 | 恢复 |
| --- | --- | --- |
| 未配置/台账无效 | 本地明确报错，不执行 SSH | 配置 inventoryFile/修复 JSON |
| 环境名称歧义/重复 id | 拒绝整个台账 | 修改别名 |
| 未知服务器/项目或多项目未选 | 预校验拒绝 | 选择准确目标 |
| host key/认证/网络错误 | 保留 SSH 退出码与 stderr | 人工核对指纹、SSH config 或密钥 |
| Compose 版本不支持 | 返回失败，不切换 docker-compose v1 | 安装 Compose v2 或人工处理 |
| 一台失败 | 标记整体失败，其余照常检查 | 定位失败机器 |
| 超时/取消 | 终止 SSH、回收监听和并发槽 | 缩小日志范围或重试 |
| 输出过多 | 有界缓存，明确 truncated | 缩小 services/tail/since |

## 6. 验收

单元测试覆盖台账/别名冲突、任意环境、多个机器/项目、命令转义与注入、SSH 安全选项、参数错用、预校验、超时/取消/输出限制、单机故障隔离、并发、插件注册释放与 worker 可见性。进程测试仅执行本地假 SSH，不连接真实服务器。完成 typecheck、全量测试及 build；文档区分已构建与当前运行实例尚未重新加载的状态。
