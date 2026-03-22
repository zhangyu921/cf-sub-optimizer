# CF IP Choose SPEC

## 1. Goal

构建一个多租户的 `Cloudflare IP choose` 服务：

- 用户提供原始订阅 URL
- 系统生成该用户专属的代理订阅 URL
- 用户通过 Worker 提供的管理页面维护各分组的 IP 条目
- 管理页面支持导入 `CloudflareSpeedTest` 结果 CSV 作为初始数据
- 管理页面支持手动新增、编辑、删除 IP 条目
- 每个 IP 条目可选填写名字；未填写时默认使用 IP 本身
- 服务端基于这些条目生成更适合该用户当前网络环境的订阅内容

第一版目标是支持 `Hiddify` 使用。

## 2. Scope

### In Scope

- 多租户
- 每租户一个原始订阅 URL
- 每租户一个代理订阅 URL
- 管理页面导入 `CloudflareSpeedTest` CSV
- 管理页面手动维护 IP 列表
- 分组名 -> alias 映射
- IP 条目的可选自定义名字
- 服务端生成 base64 订阅
- 节点模板基于原始订阅自动提取

### Out of Scope

- 纯 Web 页面直接测速
- 多协议全兼容
- 多探针合并
- 历史结果分析面板
- 通用公开优选池

## 3. First Version Constraints

第一版仅支持：

- 单协议：`VLESS + WS + TLS`
- 单类场景：`Cloudflare` 前置
- 单一输入模型：管理页面维护分组下的 IP 条目
- CSV 导入仅作为批量录入方式，不作为独立数据模型
- 单租户模板来源：原始订阅中可解析出至少一个有效 `vless://` 节点

## 4. Core Model

### Tenant

每个租户包含：

- `tenantId`
- `originSubscriptionUrl`
- `originNodeTemplate`
- `accessToken`
- `aliases`
- `groupsByKey`

说明：

- 当前 worker 实现使用单一 `accessToken`，同时用于管理页面访问、保存分组条目和读取生成订阅。
- 后续如需读写分离，可再演进为独立 token 模型。
- `groupsByKey` 表示该租户下按分组键存储的最新条目集合。

### Group Record

每个分组包含：

- `groupKey`
- `alias`
- `updatedAt`
- `items`

### Group Item

每个条目包含：

- `ip`
- `name`（可选）
- `source`（可选，示例：`csv` / `manual`）
- `latency`（可选）
- `loss`（可选）
- `speed`（可选）
- `colo`（可选）

说明：

- 订阅生成所必需的字段只有 `ip`。
- `name` 用于节点显示名，未填写时默认回退到 `ip`。
- `latency/loss/speed/colo` 主要用于 CSV 导入后的展示、排序或人工判断，不作为订阅生成的必填条件。

### Origin Node Template

从原始订阅中提取固定字段：

- `uuid`
- `port`
- `host`
- `sni`
- `path`
- `security`
- `type`

动态替换字段：

- `server address`
- `node name`

## 5. Architecture

### Dashboard UI

由 Worker 提供管理页面。

职责：

- 展示租户的代理订阅 URL 和管理链接
- 为指定分组导入 `CloudflareSpeedTest` CSV
- 将 CSV 结果转换为可编辑的条目列表
- 提供交互式表格，至少支持两列：`ip`、`name`
- 允许用户手动新增、编辑、删除条目
- 保存某个分组的最新条目集合

说明：

- CSV 导入后的结果不是最终提交态，用户可以继续修改。
- 手动新增的条目与 CSV 导入的条目在保存前统一视为同一种数据结构。

### Backend Service

使用 `Cloudflare Worker`。

职责：

- 接收管理页面提交的分组条目
- 存储每个租户、每个分组的最新条目
- 拉取并解析原始订阅
- 生成代理订阅内容
- 对外提供固定代理订阅 URL

### Storage

第一版建议：

- `KV` 保存租户配置和各分组最新条目

## 6. Subscription Behavior

### Input

用户提供：

- 原始订阅 URL
- 一个或多个分组下的 IP 条目列表

服务端解析出一个节点模板，例如：

```text
vless://uuid@example.com:443?encryption=none&host=example.com&path=%2Fbnramdon&security=tls&type=ws#name
```

### Output

服务端生成代理订阅：

- 每个 IP 条目生成一条新的 `vless://`
- 保留原模板的 `uuid/host/path/tls/ws`
- 仅替换连接地址为对应 `Cloudflare IP`
- 依据条目生成节点名字
- 多条节点按行拼接
- 最终整体做 `base64` 返回

### Node Name

建议命名：

`{aliasOrGroup}-{itemNameOrIp}`

规则：

- 分组展示名优先使用 alias；若无 alias，则使用 group key
- 无论条目是否填写 `name`，节点名前缀都必须保留 `aliasOrGroup`，用于区分不同地点或网络环境下的结果
- 若条目存在 `name` 且非空，使用 `name`
- 否则使用 `ip`

示例：

- `Home-HKG-01`
- `Home-104.16.1.1`
- `Cafe-SZ-Entry-A`

## 7. Grouping

分组键使用手动指定的字符串。

为兼容现有 API，请求体字段名仍可沿用 `ssid`，但语义上视为 group key。

展示名优先使用 alias：

- 有 alias：显示 alias
- 无 alias：显示原始分组名

存储主键始终使用原始分组键，避免 alias 变更导致数据漂移。

## 8. APIs

### `POST /api/lookup`

根据用户输入的链接定位已有租户，或在必要时创建租户。

请求体：

```json
{
  "url": "https://example.com/sub/abc"
}
```

支持输入：

- 原始订阅 URL
- 本站生成的 `subscriptionUrl`

响应体：

```json
{
  "tenantId": "t_xxx",
  "accessToken": "t_xxx.access_xxx",
  "isNew": false
}
```

行为：

- 当输入原始订阅 URL 时：若该 URL 已存在，则定位到已有租户；否则创建新租户
- 当输入本站生成的 `subscriptionUrl` 时：直接解析出对应租户并进入管理
- 前端随后跳转到 `/dashboard/:tenantId?token=<accessToken>`

### `POST /api/tenants`

创建租户。

请求体：

```json
{
  "originSubscriptionUrl": "https://example.com/sub/abc"
}
```

响应体：

```json
{
  "tenantId": "t_xxx",
  "accessToken": "t_xxx.access_xxx",
  "dashboardUrl": "https://service.example/dashboard/t_xxx?token=t_xxx.access_xxx",
  "subscriptionUrl": "https://service.example/sub/t_xxx?token=t_xxx.access_xxx"
}
```

说明：

- `dashboardUrl` 和 `subscriptionUrl` 是当前 worker 实现返回的便捷结果。
- 日常使用上，用户也可以在首页重新粘贴原始订阅 URL 或本站生成的 `subscriptionUrl` 来重新定位并进入管理。

### `GET /dashboard/:tenantId`

返回该租户的管理页面。

参数：

- `token=<accessToken>`

行为：

- 展示当前租户信息
- 支持 CSV 导入
- 支持手动编辑 IP 条目
- 支持保存分组条目

### `POST /api/report`

保存某个分组的最新条目。

Header：

```text
Authorization: Bearer <accessToken>
```

请求体：

```json
{
  "ssid": "home",
  "alias": "Home",
  "updatedAt": "2026-03-19T12:00:00Z",
  "results": [
    {
      "ip": "104.16.1.1",
      "name": "HKG-01",
      "latency": 82.3,
      "loss": 0,
      "speed": 12.4,
      "colo": "HKG"
    },
    {
      "ip": "104.16.1.2"
    }
  ]
}
```

说明：

- 为兼容现有实现，请求体字段名仍可使用 `results`。
- 语义上这里表示“该分组当前用于生成订阅的条目列表”。
- CSV 导入后可直接提交，也可先在页面中编辑后再提交。

### `GET /api/groups`

返回当前租户已保存的分组列表及其摘要信息，供管理页面展示。

### `GET /sub/:tenantId`

返回该租户的代理订阅。

参数：

- `token=<accessToken>`

行为：

- 读取该租户所有分组的最新条目
- 基于原始节点模板生成多条 `vless://`
- 拼接后 base64 返回

## 9. Dashboard Interaction

建议第一版支持以下交互：

### Enter Management

1. 用户在首页粘贴链接
2. 支持两类输入：原始订阅 URL、本站生成的 `subscriptionUrl`
3. 前端调用 `/api/lookup`
4. 服务端定位已有租户或创建新租户
5. 前端跳转到 `/dashboard/:tenantId?token=<accessToken>`

### Import CSV

1. 选择或输入分组名
2. 上传 `CloudflareSpeedTest` 结果 CSV
3. 页面解析 CSV
4. 生成可编辑条目列表
5. 用户修改 `ip` / `name`
6. 用户可手动补充新条目
7. 保存到 `/api/report`

### Edit Manually

1. 选择或输入分组名
2. 从空列表开始，手动新增条目
3. 每个条目至少填写 `ip`
4. `name` 可留空，留空时默认使用 `ip`
5. 保存到 `/api/report`

## 10. Security

- 原始订阅 URL 视为敏感信息
- 当前 worker 实现中，管理页面访问、写入接口和订阅读取共用同一个 `accessToken`
- 租户间数据严格隔离
- 首页的链接定位能力仅用于根据用户主动提供的原始订阅 URL 或本站生成的 `subscriptionUrl` 查找对应租户
- 服务端拉取原始订阅时需限制目标协议与请求行为，避免 SSRF

## 11. Recommended Project Layout

```text
src/
  worker/
  shared/
docs/
  examples/
SPEC.md
```

建议职责：

- `src/worker/`: 多租户后端与管理页面
- `src/shared/`: 订阅解析、节点生成、CSV 解析、数据类型

## 12. Milestones

### M1

- 支持创建租户
- 能解析原始订阅中的第一个 `vless://` 节点
- 能生成固定代理订阅 URL

### M2

- 管理页面支持上传 `CloudflareSpeedTest` CSV
- CSV 可转换为可编辑的 IP 条目列表
- 可保存分组条目

### M3

- 管理页面支持手动新增、编辑、删除条目
- Worker 能按分组键聚合结果
- 代理订阅可被 `Hiddify` 导入并使用

## 13. Success Criteria

满足以下条件即视为第一版成功：

- 用户提交原始订阅 URL 后，拿到新的代理订阅 URL 和管理链接
- 用户可以通过管理页面上传 CSV 或手动维护 IP 列表
- 服务端能记录当前分组的最新条目集合
- Hiddify 导入代理订阅 URL 后，能看到按分组名/alias 和条目名生成的多个节点
- 节点基于原始模板，仅替换为对应的 `Cloudflare IP`
