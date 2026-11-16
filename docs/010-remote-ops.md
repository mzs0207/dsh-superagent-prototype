# 环境与主机管理 / Linux Docker Compose 排障

## 先用 UI：创建环境和密码主机

构建并重新加载本项目后，在 **Superagent → 环境与主机** 页签操作，不需要先编辑台账文件：

1. 点击 **新增环境**，填写开发/测试/生产/开发V2等名称，可加中文别名和生产标记。允许先创建空环境。
2. 选中环境，点击 **添加主机**，填写显示名称、IP或域名、SSH端口（默认22）、用户名和密码。当前 UI **只支持直接密码认证**；不读 SSH config，不支持跳板机、密钥、OTP或 keyboard-interactive。
3. 可选填写一个或多个 Compose 项目：项目标识、远端绝对目录、Compose 文件（每行一个）；高级选项支持 projectName 和 profiles。没有项目也能查看主机容器/资源。
4. 保存仅写本地配置，不自动登录。编辑时密码为空表示保留；已有密码不回显。密码在提交、取消或切换目标时清空，不保存到浏览器 localStorage/sessionStorage，不作为模型工具参数。
5. 点击 **获取指纹**：只进行 SSH key exchange，不发送密码。通过服务器控制台等独立可信渠道核对 SHA256 指纹后，勾选核对声明并点击 **信任该指纹**。确认 token 与目标、配置版本绑定，5分钟有效、只能使用一次；不能自动接受未知密钥。
6. 点击 **测试连接**，仅尝试密码认证，不执行远程命令。成功只代表 SSH 认证成功，不代表 Docker 权限或业务健康。随后可在对话中要求只读排查。

修改主机地址或端口会清除指纹信任；需重新核对才能发送密码。更改密码、项目、用户名后，已有指纹仍对应同一服务器。配置有 revision 并发保护，遇到409请刷新并比较，不会静默覆盖其他人的修改。环境删除会一并移除其主机和密码密文，需要页面内二次确认。

### 密码如何保存

管理服务在现有主插件 `<stateDir>/remote-ops` 下保存 `state.json`（元数据和 AES-256-GCM 密文）与 `master.key`（独立随机密钥）。目录0700、文件0600；密文绑定主机UUID，原子写入，缺失/损坏密钥或不安全文件会拒绝读取，**不会重新生成密钥覆盖旧密码**。备份和恢复必须同时保留两者及权限；不要提交到Git或粘贴到聊天。

加密用于降低静态文件误泄露风险，**不防同账号/root或已控制 DSH Host 的进程读取密钥**。管理API沿用当前可信本机的loopback/Origin/自定义请求头限制，无额外用户登录或RBAC；有本机命令权限的agent/进程并不是此HTTP接口的隔离对象。生产环境还应使用受限账号、限制本机/会话访问，并避免直接将此HTTP服务开放到公网。

界面仅返回 `hasPassword`，诊断工具不返回密码、密文、密钥路径或认证材料；日志本身仍可能含业务秘密。密码通过 SSH2 库在内存中认证，不经过 sshpass、进程参数、环境变量或明文临时文件。当前没有复用或迁移 dsh-remote 已保存密码。

### 与旧台账的关系

默认 `inventoryFile` 为空时，原有 `remote_ops_inventory` / `remote_ops_inspect` 自动使用此UI管理的环境。若显式设置 `inventoryFile`，诊断工具优先使用旧文件/OpenSSH模式，**不会混合两套目标**；要让新建的密码主机参与诊断，请清空该配置并重新加载插件。下文是兼容旧台账的高级配置方式。

## 选择与边界

新增独立 DSH 原生插件 `dsh-superagent/remote-ops`，随本项目 bundle 注册。无需修改 DSH 核心；密码模式使用项目依赖 ssh2，旧台账模式才需要本机 OpenSSH `ssh`。远端需要 Linux、Docker 和 Compose v2。

- **环境 → 多台服务器 → 每机多个 Compose 项目**，支持开发、测试、生产、开发环境V2，以及任意新增名称和中文别名。
- 同一对话按环境逐台采集，返回每台服务器的目标、退出码、输出、耗时、超时和截断状态，不修改当前工作目录/远程工作区。
- 仅固定只读动作；**没有任意命令、容器 exec、重启、部署、删除、完整 Compose config 或环境变量查询**。
- 当前已安装的第三方 [dsh-remote](https://github.com/flymysql/dsh-remote) 仍负责交互式 SSH、密码登录、终端和远程工作区。本插件不读取其机器注册文件或密码，不依赖内部连接池，也不会自动导入旧 skill 中的真实服务器地址。
- UI 管理的主机使用独立的加密密码登录；可选旧台账使用本机 OpenSSH 身份：密钥、ssh-agent、`~/.ssh/config`、ProxyJump、Kerberos 等。**仅保存在 dsh-remote 中的密码不会自动复用**；需要 OTP/交互式终端时继续使用原插件。

为什么不直接复用 `rw_exec`：当前安装版本的执行按会话绑定的远程镜像选择机器，本地总控会话不能显式传 machineId 执行；公共 Host API 也没有 exec。直接切全局“当前机器”会导致多机串线，因此不采用。

## 1. 配置 SSH 身份与指纹

由运行 DSH 的本机系统账号配置 OpenSSH。以下均为**示例数据**，需替换：

```sshconfig
Host community-dev
  HostName dev.example.invalid
  User diagnostics
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes

Host community-prod-1
  HostName prod-1.example.invalid
  User diagnostics
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  ProxyJump bastion

Host bastion
  HostName bastion.example.invalid
  User diagnostics
  IdentityFile ~/.ssh/id_ed25519
```

其余 test/prod-2/dev-v2 别名同理。也可以在台账直接配置 `host`（域名/IP）、`user`、`port`、`identityFile`（本地绝对路径或 `~/`）。未提供的 user/port/密钥参数交给 OpenSSH config；不会强行覆盖成 root 或 22。

首次连接前，操作者通过可信渠道核对目标和跳板机的主机指纹，并建立 known_hosts 信任。本插件强制 `StrictHostKeyChecking=yes`，不会自动接受未知/变化的主机密钥；不要以关闭校验绕过生产环境指纹问题。强制 BatchMode，不能弹出密码或 OTP 输入。ssh-agent 中的密钥须预先解锁。

插件禁用 agent/X11 转发、本地 LocalCommand、SSH 连接复用和端口转发。受信任的本机 SSH config 仍可包含 ProxyJump/ProxyCommand/Match 等配置，应由操作者管理，不从日志或模型输出生成并执行。

## 2. 创建台账

复制并修改[完整示例台账](../examples/remote-ops.inventory.example.json)，保存到代码仓库外，例如 `/home/me/.config/dsh/remote-ops.json`，建议目录 700、文件 600。**示例中的 SSH 别名、路径、项目名都不是已验证配置。**不要提交真实地址、密码或私钥。

最小台账（示例数据）：

```json
{
  "version": 1,
  "environments": [
    {
      "id": "dev-v2",
      "label": "开发环境V2",
      "aliases": ["开发V2", "dev2"],
      "servers": [
        {
          "id": "app-1",
          "host": "community-dev-v2",
          "projects": [
            {
              "id": "community",
              "directory": "/srv/community-v2",
              "files": ["compose.yml", "compose.override.yml"]
            }
          ]
        }
      ]
    }
  ]
}
```

字段：

- `id` 为稳定标识；环境 `label` 和 `aliases` 也可精确选择目标。不使用模糊匹配或默认生产环境。规范化后冲突的环境名会拒绝加载。
- `production: true` 标注生产环境，便于结果识别，**不是权限隔离开关**。所有环境只允许相同的只读动作。
- `servers[].host` 是 SSH alias、域名或 IP，不是 URL，不带 `user@` 或 shell 参数。每个服务器可配置多个 `projects`，不同环境也可绑定同一 SSH alias 的不同目录。
- `projects[].directory` 为远端绝对路径；`files` 可省略以使用 Compose 默认文件发现。多文件按数组顺序传 `-f`；相对文件路径以项目目录为基准。
- 可选 `projectName` 对应 `--project-name`，`profiles` 对应重复 `--profile`；必须匹配实际部署，错误项目名可能得到空列表，不能据此断言服务已删除。
- 可选服务器字段 `sudo: true` 仅使固定 Docker 命令使用 `sudo -n docker`，不支持交互密码；不授予其他 shell 命令。优先直接配置最小权限诊断账号。
- 台账严格校验未知字段，不能写 `password`、`passphrase` 或自定义命令。台账有大小上限；每次调用重新读取，修改后不必重启。

## 3. 启用插件

本项目构建后包含插件入口。升级 bundle 时先执行 `pnpm check`，按现有项目部署方式加载新构建并**重启当前 DSH 实例**。仅修改源码或构建不会让正在运行的旧Host插件自动生效；现有客户端插件也已包含新管理页，需要重载后刷新原地址。没有另起 Web 服务。

在 DSH 插件管理中配置 `dsh-superagent-remote-ops` 的 `inventoryFile`，或在该 profile 配置中加入（示例数据）：

```yaml
- id: dsh-superagent-remote-ops
  config:
    inventoryFile: /home/me/.config/dsh/remote-ops.json
    timeoutSeconds: 30
    maxOutputBytes: 65536
    maxConcurrent: 2
```

配置文件示例也见 [profile patch](../examples/profile.cordis.patch.yml)。默认 inventoryFile 为空时，有主插件管理服务就使用UI台账；独立安装且无管理服务时显示待配置。保存配置本身不连接服务器。这些配置项用于旧文件/OpenSSH模式：`timeoutSeconds` 范围1..120，输出上限1KiB..1MiB（stdout+stderr合计），并发上限1..8。UI管理的密码模式当前固定每连接30秒、每机64KiB输出上限，指纹获取/测试/诊断共用2个并发连接槽。

独立使用此插件也可以在另一个 DSH bundle/profile 中插入 `name: dsh-superagent/remote-ops`，不依赖 Superagent 的仓库/飞书配置。普通 DSH 会话获得两个工具。Superagent worker 白名单也已加入这两个工具，仍受工单授权和存活 guard 约束；路由主 Session 不承担远程排障。

## 4. 对话用法

- “列出可排障的环境和服务器。”
- “检查开发环境V2所有服务器的 community 项目状态。”
- “看测试环境 test-1 上 community 的 api 服务最近30分钟日志，最多200行。”
- “对比生产环境两台服务器的 community 镜像版本和状态，不做任何变更。”
- “检查开发环境所有服务器的磁盘、内存和负载。”

工具调用示例（示例数据，配置后才可执行）：

```json
{}
```

以上调用 `remote_ops_inventory`，返回环境、别名、server/project IDs，不返回地址、认证路径或密码。之后 `remote_ops_inspect`：

```json
{
  "environment": "开发环境V2",
  "project": "community",
  "action": "logs",
  "services": ["api"],
  "tail": 200,
  "since": "30m"
}
```

不传 `server` 表示该环境内全部服务器，按配置顺序逐台执行；指定则只查这一台。Compose 动作不传 project 时，每台必须恰好配置一个项目，否则整批在本地拒绝，不猜项目、不部分执行。全量模式指定的 project 必须在每台存在；异构部署请分别指定 server/project。

| action | 用途 | 参数 |
| --- | --- | --- |
| `status` | Compose 全部容器状态，JSON 原文 | project |
| `logs` | 有限日志，无 follow、无颜色，带时间戳 | project、services、tail 1..1000 默认100、since |
| `images` | Compose 镜像 | project |
| `top` | Compose 进程 | project、services |
| `services` | 只输出 Compose 服务名，不输出配置/环境变量 | project |
| `containers` | 主机 docker ps --all --no-trunc | 无项目参数 |
| `resources` | 内核、负载、磁盘、内存 | 无项目参数 |
| `docker_version` | Docker / Compose 版本 | 无项目参数 |

`since` 支持 `30m`、`2h` 等时间段或 RFC3339 时间。只有 logs 接收 tail/since；services 仅 logs/top 可用。错误/未知参数直接拒绝。

每台结果明确 `ok/exitCode/signal/stdout/stderr/durationMs/truncated/timedOut/cancelled`。一台出错会保留失败并继续其他台，整体 `ok=false`；取消则停止后续采集。输出超限继续排空而不无限缓存，并设置 truncated；这时应缩小服务/时间范围，不能把截断结果当完整日志。SSH 超时或取消会终止本地 SSH 并等待其退出；断开连接不保证远端命令立即死亡，所以没有长期 follow 命令。DSH 原生日志记录工具调用和结果，本插件不另存一份敏感日志。

## 安全与排错

1. **只读工具不等于账号只读。** 插件运行在 DSH Host 权限下，不借用本地文件沙箱来声明远端隔离；Docker group 通常相当于 root 权限。生产请配专用账号、SSH forced-command/诊断 wrapper、网络限制和独立授权。具有普通 bash/其他 SSH 工具的 agent 仍可能绕过本插件；若需要整个系统不可变更，必须同时收窄那些工具和远端账号权限。
2. **所有有权使用这两个工具的会话共享操作者配置的台账权限**，首版没有按用户/环境的 RBAC。生产数据访问控制需要在启用前从 DSH 会话访问和远端身份层解决。
3. 日志、进程参数、磁盘挂载信息可能包含令牌/业务数据，结果会进入会话和持久化历史。本插件没有承诺自动脱敏；仅收集必要服务、较短时间窗，不让模型服从远端日志中的指令。
4. `Host key verification failed`：人工核对 known_hosts 和服务器指纹；不自动关闭校验。`Permission denied`：检查 DSH 系统账号的 SSH config、密钥和 agent；不是通过增加模型审批权限修复。
5. Docker permission/sudo 错误：配置最小权限；不要为方便给任意 shell NOPASSWD。Compose v1 或旧版不支持参数时返回真实错误，不自动降级或安装软件。
6. 状态为空时核对项目目录、files、projectName、profiles 和实际服务；SSH 成功不代表业务健康。资源命令中每项均标注退出码，任一失败不得报告整台完整检查成功。
7. 本次开发验证使用本地假进程、加密台账、模拟HTTP/DOM和临时loopback SSH测试服务，**没有登录任何用户真实服务器**。配置、指纹和真实环境连通性均为操作者待验证项。
