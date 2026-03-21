# CF IP Choose SPEC

## 1. Goal

构建一个多租户的 `Cloudflare IP choose` 服务：

- 用户提供原始订阅 URL
- 系统生成该用户专属的代理订阅 URL
- 用户在本地运行探针，按手动指定的分组名上报优选结果
- 服务端基于这些结果生成更适合该用户当前网络环境的订阅内容

第一版目标是支持 `Hiddify` 使用。

## 2. Scope

### In Scope

- 多租户
- 每租户一个原始订阅 URL
- 每租户一个代理订阅 URL
- 本地探针按分组名采集并上报结果
- 分组名 -> alias 映射
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
- 单探针：每个用户自己本地运行 Agent
- 单租户模板来源：原始订阅中可解析出至少一个有效 `vless://` 节点

## 4. Core Model

### Tenant

每个租户包含：

- `tenantId`
- `originSubscriptionUrl`
- `originNodeTemplate`
- `uploadToken`
- `readToken`
- `aliases`
- `reportsBySsid`

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

## 5. Architecture

### Local Agent

职责：

- 解析本次运行的分组名
- 运行 `CloudflareSpeedTest`
- 解析 `result.csv`
- 选取前 `N` 个优选 IP
- 读取本地 alias
- 上传到服务端

### Backend Service

使用 `Cloudflare Worker`。

职责：

- 接收测速上报
- 存储每个租户、每个分组的最新结果
- 拉取并解析原始订阅
- 生成代理订阅内容
- 对外提供固定代理订阅 URL

### Storage

第一版建议：

- `KV` 保存租户配置和各分组最新结果

## 6. Subscription Behavior

### Input

用户提供：

- 原始订阅 URL

服务端解析出一个节点模板，例如：

```text
vless://uuid@example.com:443?encryption=none&host=example.com&path=%2Fbnramdon&security=tls&type=ws#name
```

### Output

服务端生成代理订阅：

- 每个优选 IP 生成一条新的 `vless://`
- 保留原模板的 `uuid/host/path/tls/ws`
- 仅替换连接地址为优选 `Cloudflare IP`
- 多条节点按行拼接
- 最终整体做 `base64` 返回

### Node Name

建议命名：

`{aliasOrGroup}-{rank}-{colo}-{latency}ms`

示例：

- `Home-01-HKG-82ms`
- `Cafe-SZ-02-NRT-96ms`

## 7. Grouping

分组键使用手动指定的字符串。

为兼容现有 API，请求体字段名仍沿用 `ssid`，但语义上视为 group key。

展示名优先使用 alias：

- 有 alias：显示 alias
- 无 alias：显示原始分组名

存储主键始终使用原始分组键，避免 alias 变更导致数据漂移。

## 8. APIs

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
  "proxySubscriptionUrl": "https://service.example/sub/t_xxx?token=read_xxx",
  "uploadToken": "upload_xxx"
}
```

### `POST /api/report`

上报某个分组的测速结果。

Header：

```text
Authorization: Bearer <uploadToken>
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
      "latency": 82.3,
      "loss": 0,
      "speed": 12.4,
      "colo": "HKG"
    }
  ]
}
```

### `GET /sub/:tenantId`

返回该租户的代理订阅。

参数：

- `token=<readToken>`

行为：

- 读取该租户所有分组的最新结果
- 基于原始节点模板生成多条 `vless://`
- 拼接后 base64 返回

## 9. Local Agent Commands

建议第一版支持：

- `run-once`
- `preview`

其中 `run-once` 流程为：

1. 解析本次分组名（CLI `--group` 优先，否则使用配置默认值）
2. 运行 `CloudflareSpeedTest`
3. 解析结果
4. 取前 `topN`
5. 上报到 `/api/report`

## 10. Security

- 原始订阅 URL 视为敏感信息
- 上报接口必须使用 `uploadToken`
- 订阅读取必须使用 `readToken`
- 租户间数据严格隔离
- 服务端拉取原始订阅时需限制目标协议与请求行为，避免 SSRF

## 11. Recommended Project Layout

```text
src/
  agent/
  worker/
  shared/
docs/
  examples/
SPEC.md
```

建议职责：

- `src/agent/`: 本地探针
- `src/worker/`: 多租户后端
- `src/shared/`: 订阅解析、节点生成、数据类型

## 12. Milestones

### M1

- 支持创建租户
- 能解析原始订阅中的第一个 `vless://` 节点
- 能生成固定代理订阅 URL

### M2

- 本地 Agent 能按分组名运行
- 能跑 `CloudflareSpeedTest`
- 能上报前 `N` 个优选 IP

### M3

- Worker 能按分组键聚合结果
- 代理订阅可被 `Hiddify` 导入并使用

## 13. Success Criteria

满足以下条件即视为第一版成功：

- 用户提交原始订阅 URL 后，拿到一个新的代理订阅 URL
- 用户本地运行 Agent 后，服务端能记录当前分组的优选结果
- Hiddify 导入代理订阅 URL 后，能看到按分组名/alias 命名的多个节点
- 节点基于原始模板，仅替换为优选 `Cloudflare IP`
