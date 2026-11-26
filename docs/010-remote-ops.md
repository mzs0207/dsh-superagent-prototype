# 环境资源：连接配置、项目与团队

## 拆分升级：保留已有环境与主机

在加载新构建**之前**，备份原 `<Superagent stateDir>/remote-ops/`（包括 `state.json` 和 `master.key`），然后在本地 profile 的 `cordis.patch.yml` 给 `dsh-superagent-remote-ops` 设置 `config.stateDir`，值为**原目录的绝对路径**，而不是 Superagent 的上一级目录。见 [profile 示例](../examples/profile.cordis.patch.yml)。若已有对应配置块，在同一块内加入 `stateDir`，保留 `inventoryFile` 等原选项。

重启同一 DSH profile 后，独立插件原地接管台账，不移动或重写旧文件，不需要重新录入密码或信任指纹。不要让多个 profile 共用同一台账。旧台账（v1/v2）可读，首次修改时写 v3，保留原 ID、指纹和密码密文。需要退回旧版时，先停止新版，再成对恢复升级前备份的 `state.json` 和 `master.key`；新版写入不会出现在旧备份中。

## 先用 UI：创建环境和 SSH 主机

在 DSH 左下角打开 **设置 → 环境资源**，不打开新标签页。仅加载 `dsh-superagent/remote-ops` 的 profile 可用同源直达页 `/environment-resources`；管理 API 和工具不依赖 Superagent 启动。

1. 点击 **新增环境**，填写开发/测试/生产/开发V2等名称，可加中文别名和生产标记。允许先创建空环境。
2. 选中环境，点击 **新增主机**，填写显示名称、IP 或域名、SSH 端口（默认 22）、用户名和认证方式。选 **SSH 私钥** 时粘贴完整私钥（含 BEGIN/END 行），加密私钥还须填写口令。UI 不读取本机私钥路径或 SSH config，也不支持跳板机、ssh-agent、OTP 或 keyboard-interactive。
3. 可选填写一个或多个 Compose 项目：项目标识、远端绝对目录、Compose 文件（每行一个）；高级选项支持 projectName 和 profiles。没有项目也能查看主机容器/资源。
4. 保存仅写本地配置，不自动登录。编辑时认证方式不变且凭据字段留空，就保留原凭据；切换方式须录入新凭据。密码、私钥和口令不会回显，提交、取消或切换时清空输入，不保存到浏览器存储，也不作为模型工具参数。
5. 点击 **获取指纹**：只进行 SSH 密钥交换，不使用登录凭据。通过服务器控制台等独立可信渠道核对 SHA256 指纹后，勾选核对声明并点击 **信任该指纹**。确认 token 与目标、配置版本绑定，5 分钟有效、只能使用一次；不能自动接受未知主机密钥。
6. 点击 **测试连接**，按选定方式尝试 SSH 认证，不执行远程命令。成功不代表 Docker 权限或业务健康。随后可在对话中要求只读排查。

修改主机地址或端口会清除指纹信任，须重新核对才能认证。更改认证方式、凭据、项目或用户名，不清除同一主机的指纹信任。配置有 revision 并发保护，遇到 409 请刷新并比较。环境删除连同所有资源和密文删除，需要页面内二次确认。

### 公用环境、项目与团队

- **公用环境**固定置顶，不能改名、删除或标记生产。已有「通用环境」等自建环境不迁移。按普通环境查询时可看到公用项目与人员资料，结果标明所属环境。SSH、数据库、网站账号始终按显式指定的环境解析，不回退到公用连接，也不改变原有 Worker 和生产限制。
- **新增项目**填写项目名、本机 Git 仓库根目录的绝对路径、远端 Git 地址和备注。远端地址仅用于记录，不克隆、不拉取。新项目保存后扫描当前 `HEAD` 的全部 Git 跟踪目录，按顶层目录分层；不读取未提交文件、不追踪符号链接或子模块、不执行仓库内容。运行期间每分钟检查本地提交；仅更新新增、删除或有修改的层，历史分叉或上次提交已不可用时重建。同一提交不重复总结，也可手动立即检查。
- 点开项目的 **仓库总结** 查看或下载概括及详细分层 Markdown；两份内容标注同一 commit。扫描失败时保留上次成功结果；同一次运行中，失败的提交不自动反复提交给模型，可手动重试。默认只在本机生成结构总结；逐项目启用 **模型语义总结** 并指定 DSH 的提供方和模型 ID 后，初始化和新提交会把少量筛选后的已提交片段发给该模型，不给模型工具或执行权限。筛选不保证检出秘密；无权向该服务传输源码时不要启用。
- **项目关系**从台账的既有项目选两个，支持跨环境，按稳定 ID 保存方向与描述。被引用的项目须先解除外部关系才能删除，与 Linux 主机的 Compose 项目不是同一类型。**使用者描述**记录姓名、岗位和负责业务；**团队**记录成员姓名及 Git 邮箱。
- `remote_ops_resources` 支持 `project`、`project-relationship`、`person` 和 `team`，可在指定项目 ID 时用 `summary: "overview"` 或 `"detail"` 读有界 Markdown。项目资料、成员邮箱和总结均为会话可见的参考资料，不是权限或指令。

### 在环境之间复制或移动记录

在任意资源记录上点击 **迁移**，选择 **复制** 或 **移动** 和目标环境，再确认。成功后跳到目标环境。复制生成新 ID 并保留源记录；移动保留原 ID，引用它的项目关系不变。不会覆盖目标记录。

迁移只改本地台账，不连接、移动或修改远程服务。同一登录目标的密码、私钥、口令及已核对的主机指纹继续有效；数据库和网站账号在目标记录上默认关闭 Worker 授权。复制项目保留已有总结，但不会启动扫描或继承模型授权；移动保留该项目的扫描和模型设置。迁移涉及生产或公用环境时，注意目标环境的凭据使用限制和资料可见范围。

### 导入与导出

在 **导入配置 / 导出配置** 下载带版本的 JSON，或选择文件并先预览。导出包含连接配置和认证方式、环境、项目、关系与已有总结，不包含密码、私钥、口令、密文、主密钥或 SSH 指纹信任；账号名、地址、人员资料和总结仍可能敏感。它不是台账灾难恢复备份。

导入前检查 UUID、关系引用及配置冲突；相同记录跳过，不覆盖已有不同记录。新的连接须重新输入对应的密码或私钥，SSH 主机须重新核对指纹。新导入的项目不会扫描，确认本机路径并保存后才扫描；模型和 Worker 授权、社区 Web 条款同意需重新设置。确认引入的所有配置一次原子保存，预览后若版本变更则拒绝并要求重做预览。

### 数据库、网站账号和备注

- **新增数据库**：填写 PostgreSQL 地址、端口、库名和专用只读账号。新记录默认关闭 **使用 TLS**；旧记录继续启用 TLS。启用后验证服务器证书，不自动回退到明文；有私有证书链时提供可信 CA PEM。关闭后连接不加密，仅用于可信内网。连接检查只在只读会话执行固定 `SELECT 1`；不会运行用户提供的 SQL，不自动建立 SSH 隧道。
- **新增网站账号**：显式选择 **OMS、WorksBase 社区、禅道**，再填站点地址、账号和密码。OMS 和社区用邮箱；禅道用用户名，支持 `/zentao` 等安装子路径。其余站点填根地址，不带登录路径、查询参数或账号。旧账号默认 OMS，原 ID 和凭据不变。更改登录系统或站点须重新输入密码，避免把旧凭据发给不同系统。
  HTTPS 保持支持；HTTP 仅接受 RFC 1918 私网 IPv4（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`，可带端口）。HTTP 会明文传输密码和登录令牌，仅用于可信内网。
- Web 检查依赖 Chromium。可在本项目安装匹配的 `pnpm exec playwright-core install chromium`，或在插件配置中指定可信 Chromium 的绝对路径 `browserExecutable`。API 和 PostgreSQL 检查不需要启动浏览器。
  社区 Web 登录需要账号持有人先阅读该站条款和隐私政策，并在资源表单确认；API 登录无需此选项。社区清理只丢弃本地登录态，不调用会注销所有设备的接口。
- 每条资源可填最多 2000 字符的**备注**，只写用途、角色或访问前提，不写密码、令牌、连接串中的秘密或执行指令。备注会用于会话检索，不进入 Hindsight。更改数据库或网站登录目标时必须重新确认密码。生产环境禁用新增类型的凭据检查；Worker 需单条资源显式启用，子代理不能代用凭据。

普通会话和获授权 Worker 使用 `remote_ops_resources` 按环境、类型、资源 ID 或名称/备注关键词定位资源。`remote_ops_resource_check` 对明确的资源做一次性检查，`action` 为 `database`、`web` 或 `api`。`inventoryFile` 仍只覆盖 SSH 旧工具，不覆盖托管资源。

登录后，使用 `remote_ops_resource_read` 在**同一会话**读取该系统支持的只读路径；禅道路径相对安装目录，例如 `/api.php/v1/products`，不用再写 `/zentao`。OMS API 支持 `/api/oms/` 下的 GET（排除认证路由）；社区支持 `/api/users/user-profiles` 与 `/api/resources/work/list`；禅道 API 支持产品和缺陷查询，Web 仅支持已确认的查看页面，因为部分禅道操作也使用 GET。不恢复逐账号路径白名单，不跟随重定向，不允许跨站或业务写入。输出只包含有界的页面文本或脱敏 JSON，不返回密码、Cookie 或 Token。登录态最多 5 分钟，过期、会话销毁或插件停止时清理；台账变更后重新登录。

### 凭据如何保存

插件在其 `stateDir` 保存 `state.json`（元数据和 AES-256-GCM 密文）与 `master.key`（独立随机密钥），持有目录锁直至写入结束。目录 0700、文件 0600；密文按资源 UUID 绑定，原子写入。缺失或损坏密钥、文件权限不安全会拒绝读取，不会重新生成密钥覆盖旧凭据。备份和恢复必须同时保留两者及权限。

加密用于降低静态文件误泄露风险，**不防同账号/root或已控制 DSH Host 的进程读取密钥**。管理API沿用当前可信本机的loopback/Origin/自定义请求头限制，无额外用户登录或RBAC；有本机命令权限的agent/进程并不是此HTTP接口的隔离对象。生产环境还应使用受限账号、限制本机/会话访问，并避免直接将此HTTP服务开放到公网。

界面只获取认证方式等配置元数据，诊断工具不返回密码、密文、密钥路径或认证材料；日志本身仍可能含业务秘密。SSH 凭据通过 SSH2 库在内存中使用，不经过进程参数、环境变量或明文临时文件。当前不复用 dsh-remote 的凭据。

### 与旧台账的关系

默认 `inventoryFile` 为空时，原有 `remote_ops_inventory` / `remote_ops_inspect` 自动使用此 UI 管理的环境。若显式设置 `inventoryFile`，诊断工具优先使用旧文件/OpenSSH 模式，不混合两套目标；要让新建主机参与诊断，请清空该配置并重新加载插件。下文是兼容旧台账的高级配置方式。

## 选择与边界

独立 DSH 原生插件 `dsh-superagent/remote-ops` 随本项目 bundle 注册，也可单独挂载，不需要单独进程。管理页面使用同一个仅监听 `127.0.0.1` 的 DSH Web 服务，不经手机网关。托管 SSH 使用 ssh2，旧台账模式才需要本机 OpenSSH `ssh`。远端需要 Linux、Docker 和 Compose v2。

- **环境 → 多台服务器 → 每机多个 Compose 项目**，支持开发、测试、生产、开发环境V2，以及任意新增名称和中文别名。
- 同一对话按环境逐台采集，返回每台服务器的目标、退出码、输出、耗时、超时和截断状态，不修改当前工作目录/远程工作区。
- 仅固定只读动作；**没有任意命令、容器 exec、重启、部署、删除、完整 Compose config 或环境变量查询**。
- 当前已安装的第三方 [dsh-remote](https://github.com/flymysql/dsh-remote) 仍负责交互式 SSH、密码登录、终端和远程工作区。本插件不读取其机器注册文件或密码，不依赖内部连接池，也不会自动导入旧 skill 中的真实服务器地址。
- UI 管理的主机使用加密保存的密码或私钥；可选旧台账使用本机 OpenSSH 身份：密钥、ssh-agent、`~/.ssh/config`、ProxyJump、Kerberos 等。仅保存在 dsh-remote 中的凭据不会自动复用；需要 OTP 或交互式终端时继续使用原插件。

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

本项目构建后包含插件入口及独立页面。升级 bundle 时先验证新构建，按开头说明设置 `stateDir`，并**重启当前 DSH 实例**。仅修改源码或构建不会让正在运行的旧 Host 插件自动生效。

在 DSH 插件管理中配置 `dsh-superagent-remote-ops` 的 `inventoryFile`，或在该 profile 配置中加入（示例数据）：

```yaml
- id: dsh-superagent-remote-ops
  config:
    inventoryFile: /home/me/.config/dsh/remote-ops.json
    timeoutSeconds: 30
    maxOutputBytes: 65536
    maxConcurrent: 2
```

默认 `inventoryFile` 为空时，工具使用 `stateDir` 指定的台账；两者都为空时工具提示待配置，管理页面不挂载。保存配置本身不连接服务器。上述超时、输出、并发选项仅适用于旧文件/OpenSSH 模式：`timeoutSeconds` 1..120，`maxOutputBytes` 1KiB..1MiB，`maxConcurrent` 1..8。UI 管理的 SSH 固定每连接 30 秒、每机 64KiB 输出，指纹获取、测试和诊断共用 2 个并发连接槽。

独立使用时，在安装了同一包的 DSH profile 中仅插入 `name: dsh-superagent/remote-ops`，配置插件的 `stateDir`；无需安装工单主插件或配置仓库、飞书。普通 DSH 会话可调用工具；Superagent Worker 仍受白名单和工单存活 guard 约束。路由主 Session 不承担远程排障。

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
