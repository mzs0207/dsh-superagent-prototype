# Detailed Design: 环境与主机 UI、密码 SSH

## 1. 上下文与目标

在已有只读 remote-ops 插件上增加真实 React 管理页面。主 Superagent Runtime 持有管理服务，使用自己的私有 stateDir，无需操作者手写 JSON。已有 inventoryFile/OpenSSH 模式保持兼容；设置 inventoryFile 时工具明确使用旧台账，否则工具动态使用管理服务。管理页只管理自己的密码主机，不修改 dsh-remote 台账、凭据或当前远程工作区。

## 2. 数据与存储

公开合同由 src/remote-ops/managed-types.ts 提供，浏览器只能 type-only 导入。ManagedView={revision,environments}；环境有 UUID、名称、别名、production、hosts，允许空环境；主机有 UUID、显示名、host、port、username、auth=password、hasPassword、hostKeyFingerprint、projects。项目沿用既有目录/files/projectName/profiles 模型。UI 不回显密码，不把表单写入 local/sessionStorage 或 agent/tool 日志。

ManagedStore 在 <stateDir>/remote-ops 下保存 metadata+每主机 AES-256-GCM 密文；master.key 为独立 32 字节随机密钥。目录 0700、文件 0600，原子写入，拒绝不安全文件类型/符号链接。密文以主机 UUID 为 AAD，换主机不能重放。状态存在而密钥丢失时 fail closed，不重建密钥覆盖。私有目录与密钥必须一起备份；这是本机静态加密，不防同账号/root/DSH Host 进程已被控制。

所有写入以 revision CAS 和实例写队列串行化；Runtime 已锁住整个 stateDir，阻止第二实例。创建/编辑/删除均返回完整的无密钥 ManagedView；新增主机必须有密码，编辑时未提供或空字符串表示保留；删除连同密文删除。地址或端口变更清除指纹信任；用户名/密码和项目变更不改变主机身份。环境名称/别名规范化后唯一，主机/项目标识合法且同集合唯一。

## 3. 类和接口

- ManagedStore：持久化、校验、CAS、加解密、无密码视图。view/createEnvironment/updateEnvironment/deleteEnvironment/createHost/updateHost/deleteHost/trustHost/credentials。credentials 仅服务内部调用，须匹配 expectedRevision，永不注册成工具或 GET 路由。
- Password SSH transport：正式依赖 ssh2，直接 password 认证，不使用 sshpass/argv/env/临时明文文件。probeHostKey 不发送密码，取得服务器 key 并拒绝认证。runPasswordSsh 仅接受内部生成的固定诊断命令和已锁定指纹，输出沿用 ProcessResult，带超时/取消/共享并发限制，所有连接/通道最终关闭。
- ManagedRemoteOps (Cordis service remoteOps)：组合 store、密码传输、现有命令计划和 RemoteOps bounded runner；管理 API 与工具只调用本服务。不注册任何修改台账/取密码/信任指纹的模型工具。
- React RemotePage：顶层“环境与主机”页签，环境列表/新增编辑删除、当前环境主机卡片/新增编辑删除、可选 Compose 项目编辑、获取指纹→可信渠道核对→显式信任、测试连接。表单为内联，删除需要内联确认，不使用浏览器弹窗。中英文文案、加载/空态/错误/提交禁用/过期请求隔离。

## 4. 管理 API

所有接口在现有 /orchestrator/api/remote 下，沿用 loopback Host、Origin、x-orchestrator-request、防跨站请求、no-store、128KiB body 限制；不允许 mobile gateway 转发。管理写入不经过模型 Action，密码只在用户提交的 POST/PUT 请求中短暂出现，不回传。

- GET remote -> ManagedView
- POST remote/environments (EnvironmentWrite) -> ManagedView
- PUT/DELETE remote/environments/:environment (write 或 {revision}) -> ManagedView
- POST remote/environments/:environment/hosts (HostWrite) -> ManagedView
- PUT/DELETE remote/environments/:environment/hosts/:host -> ManagedView
- POST .../:host/probe ({revision}) -> HostKeyProbe
- POST .../:host/trust ({revision,token}) -> ManagedView
- POST .../:host/test ({revision}) -> ConnectionTest

probe 记录随机一次性 token 与 environment/host/endpoint/revision/指纹，5 分钟有效。trust 必须匹配未使用 token 与当前 revision/endpoint，成功后消费；不能凭前端随意传 fingerprint 就信任。测试连接和诊断都须已信任指纹，变化则拒绝，不自动覆盖。测试只认证，不执行远程变更或任意命令。错误只返回固定非敏感文案。

## 5. 调用顺序与算法

UI 保存密码 -> CAS 校验/加密/原子落盘 -> 无密码视图 -> probe SSH 握手（不发密码） -> 用户核对指纹 -> token-bound trust -> test 密码认证 -> agent inventory 查看环境和项目 -> 显式环境诊断 -> 快照预验证全部目标 -> 执行前 CAS 取密码 -> 固定命令 -> 分机有限结果。跨请求并发受共享 slots 控制；配置变更不会让正在排队的诊断偷偷换主机。

台账操作 O(状态大小)，SSH 输出内存 O(maxOutputBytes×并发数)，每目标超时有界；取消不再扇出后续机器。状态/密钥错误不触发自动重置或跨环境回退。

## 6. 异常与恢复

| 场景 | 行为 |
|---|---|
| 过期 revision | 409，用户重新加载并比较，不静默覆盖 |
| 缺密码/无效地址或重复名称 | 400，尚未连接 |
| 未知主机/环境 | 404 |
| 指纹未信任/变化、token过期 | 明确拒绝，重新获取并经可信渠道核对 |
| 密码错误/网络/超时 | 固定文案，不泄露密码或协议调试 |
| 密钥丢失/损坏/不安全文件 | fail closed，操作员恢复备份 |
| UI切换目标/卸载 | 清空密码；忽略旧请求结果，不误保存到另一环境 |

## 7. 验收与运行

测试 store 权限/原子/CAS/重启解密/密钥丢失/密文篡改/无密码输出；本地 ssh2 测试服务器验证真实密码认证、probe 不发密码、pin mismatch 不发密码、超时/取消/截断；HTTP origin/CSRF/body/revision/隐藏密码和 challenge；UI 创建编辑删除、密码不回显/不持久化、指纹信任、连接反馈、加载错误和响应乱序。全部只用本地假/临时 SSH 服务器，不连接操作者真实主机。

最后 pnpm check 构建现有 Web 插件，确认现有 http://127.0.0.1:3082 可达并区分“新产物已构建”和“运行实例已重载”。当前没有 dev:web watcher；不得承诺自动热更新，不启动替代服务器，也不在任务途中重启承载本会话的 DSH。
