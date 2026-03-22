# cf-sub-optimizer

一个基于 Cloudflare Worker 的多租户 Cloudflare IP 优选订阅服务。

用户提供原始订阅 URL，系统提取节点模板，并生成该用户专属的代理订阅 URL；同时提供一个管理页面，用来导入 `CloudflareSpeedTest` CSV 结果或手动维护 IP 列表。

当前第一版目标是支持 `Hiddify` 使用场景，范围聚焦在 `VLESS + WS + TLS`。

## 功能概览

- 多租户订阅管理
- 通过原始订阅 URL 自动定位或创建租户
- 为每个租户生成独立的管理链接和订阅链接
- 支持导入 [`CloudflareSpeedTest`](https://github.com/XIU2/CloudflareSpeedTest) 的 CSV 结果
- 支持手动新增、编辑、删除 IP 条目
- 支持分组和 alias 映射
- 基于原始订阅模板动态生成代理订阅内容

## 项目结构

```text
src/
  worker/   Cloudflare Worker 后端与管理页面
  shared/   订阅解析、CSV 解析、类型定义与节点生成
SPEC.md     详细规格说明
```

当前主入口：

- Worker 入口：`src/worker/index.ts`
- 包入口：`src/index.ts`

## 当前实现范围

当前实现的核心能力包括：

- 首页输入原始订阅 URL 或本站生成的订阅 URL
- 自动定位已有租户，或创建新租户
- 管理页面查看租户信息与订阅链接
- 保存和读取分组下的 IP 条目
- 输出 base64 编码的代理订阅内容

主要接口包括：

- `POST /api/lookup`
- `POST /api/tenants`
- `POST /api/report`
- `GET /api/groups`
- `GET /api/group`
- `GET /dashboard/:tenantId`
- `GET /sub/:tenantId`

完整数据模型、行为约束和接口定义见 [`SPEC.md`](./SPEC.md)。

## 运行要求

- Node.js
- npm
- Cloudflare 账号
- Wrangler CLI（本项目通过 npm 依赖提供）
- 两个 Cloudflare KV Namespace：
  - `TENANTS`
  - `REPORTS`

## 本地开发

安装依赖：

```bash
npm install
```

类型检查：

```bash
npm run check
```

构建：

```bash
npm run build
```

启动本地 Worker：

```bash
npm run worker:dev
```

## 部署

部署前请先确认：

1. 已登录 Wrangler
2. 已创建 Cloudflare KV Namespace
3. 已将 `wrangler.toml` 中的 KV namespace ID 替换为你自己的配置

部署命令：

```bash
npm run worker:deploy
```

## 使用流程

1. 启动本地开发服务或部署到 Cloudflare
2. 打开首页并输入原始订阅 URL
3. 系统创建或定位租户
4. 进入管理页面
5. 导入 [`CloudflareSpeedTest`](https://github.com/XIU2/CloudflareSpeedTest) 的 CSV，或手动维护 IP 列表
6. 保存分组结果
7. 使用生成的订阅链接给客户端导入

## 实现说明

- 当前使用 Cloudflare KV 保存租户信息和各分组结果
- 当前使用单一 `accessToken` 同时用于管理页面访问、数据写入和订阅读取
- 原始订阅中会提取第一个有效 `vless://` 节点作为模板
- 当前范围聚焦 Cloudflare 前置与 `VLESS + WS + TLS`

## 相关项目

- [`CloudflareSpeedTest`](https://github.com/XIU2/CloudflareSpeedTest)：用于生成可导入的测速 CSV 数据

## 文档

- [`SPEC.md`](./SPEC.md)：完整规格、架构、里程碑、接口与数据模型

## License

[MIT](./LICENSE)
