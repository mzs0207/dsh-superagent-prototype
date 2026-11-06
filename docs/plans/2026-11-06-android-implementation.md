# Android Task Viewer Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** 提供同局域网使用、仅展示任务的安卓 APK，不开放原有管理端。

**Architecture:** 独立 Node HTTPS 网关通过固定本机管理 API 读取任务，输出最小白名单投影并承载轻量页面。安卓平台 WebView 加载该页面，使用连接信息中的密钥和证书指纹限定访问。现有执行器、数据库、来源插件和管理接口不改动。

**Tech Stack:** Node 标准库、TypeScript、现有 tsdown/vitest、HTML/CSS/JavaScript、Android Java/WebView/Gradle。

---

## Task 1：只读 HTTPS 网关与连接命令

Files: 新增 `src/mobile/gateway.ts`、`src/mobile/cli.ts`、`tests/mobile.spec.ts`；修改 `tsdown.config.ts`、`package.json`。

1. 写 HTTP 集成测试：未授权拒绝、只读路径/方法白名单、字段裁剪、分页参数、404 与断线、跨来源与重定向拒绝。
2. `pnpm exec vitest run tests/mobile.spec.ts`，确认尚未实现行为导致失败。
3. 实现固定上游 `http://127.0.0.1:<port>`，只发 GET 且自动设置本机管理头；仅 `/api/tickets`、`/api/tickets/:id`。禁止透传客户端认证头与任意路径；上游失败统一不泄漏内部细节。
4. 使用 HTTPS、随机密钥恒定时间比较、HttpOnly/Secure/SameSite Cookie、精确 Host/Origin、安全响应头；保留响应字段白名单。
5. 命令 `pnpm mobile setup --host <LAN-IP>` 生成私有配置和自签证书；`pnpm mobile connection` 显示可粘贴信息；`pnpm mobile start` 前台启动，支持正常退出。不自动启动/重启用户的 DSH 服务。支持显式上游端口与状态目录。
6. 运行针对性测试和实际 HTTPS 请求，验证允许读取而拒绝写入。

## Task 2：手机只读页面

Files: 新增 `src/mobile/view.html`、`src/mobile/view.js`、`src/mobile/view.css`；构建把固定资源打入网关。

1. 实现连接状态、列表/状态筛选/分页、详情/返回/刷新；显示说明、报告和阻塞原因，所有任务文本用 textContent。
2. 前台5秒轮询、隐藏停止、请求互斥、AbortController 防止切换后的旧响应覆盖；显示最后刷新时间、错误和空列表。
3. 浏览器实际访问 HTTPS，在手机视口检查长标题、分页、详情、恶意文本、断线保留与恢复。只为存在回归风险的边界保留测试，不做源代码文本断言。

## Task 3：安卓壳与 APK

Files: 新增 `apps/android/` Gradle 项目、Manifest、Java Activity 和资源，`.gitignore` 忽略构建/私钥。

1. Java 原生输入页接收 JSON 连接信息：严格 HTTPS 私有 IPv4 地址、密钥、SHA256 指纹；只保存一个连接。
2. 以系统 WebView 展示网页；只对精确已保存来源发凭据，验证绑定证书及有效期，拒绝重定向到第三方。禁用文件/内容访问、混合内容及备份；无 JS 原生能力桥。
3. 返回键优先网页历史，提供更换连接和重试；前后台与页面可见性一致。
4. 构建 debug APK；检查 APK manifest 权限及签名；有模拟器则 adb 安装并验证连接、列表/详情、重新打开、错误证书和后台恢复。

## Task 4：集成、文档与验收

Files: 修改 `README.md`、`docs/007-architecture.md`；新增 `docs/009-mobile.md`。

1. 文档记录构建、启动、粘贴连接、轮换密钥、局域网防火墙与 WSL 可达性；不自动改系统网络/防火墙。
2. 更新完整模块/测试清单，保留文档编号、链接、类注释和 bundle 门禁。
3. `pnpm check`；构建 APK；真实网关读取现有本机接口（只读、不重启）与合成多状态任务页面验证。
4. 先核对已确认需求，再审代码安全/维护性，修复发现的问题并针对性复验。保留主目录原有未提交改动，不擅自发布或部署。
