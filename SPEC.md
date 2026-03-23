# CF IP Choose SPEC

## 1. Goal

构建一个多租户的 Cloudflare IP 优选订阅服务：

- 用户提供**原始订阅 URL**（或本站生成的订阅链接），系统绑定租户并生成**专属代理订阅 URL** 与**管理链接**。
- 用户通过 Worker 提供的**管理页面**（或 **HTTP API**）维护各分组下的 IP 条目。
- 管理页支持上传 **CFST / mcis** 导出的 CSV 快速录入，也支持**全手动**编辑；其他来源可在表格中自行填写 IP 与名称。
- 可选在订阅**末尾**合并 **Hostmonit** 公开优选 IP（第三方维护，与自建分组独立）。
- 服务端基于条目与节点模板生成 **base64 编码的多行 `vless://` 文本**；凡支持该类订阅的客户端均可使用（文档常以 `Hiddify` 为例）。

---

## 2. 推荐阅读顺序（为何调整）

早期 SPEC 将 **API 细节**放在**用户如何操作**之前，对「先理解产品再对接实现」不够友好。当前结构约定为：

1. **主路径**（本节 + §3）：谁做什么、订阅里有什么。
2. **数据模型**（§4）：租户、分组、条目存什么。
3. **订阅里长什么样**（§5）：Origin、自建节点、Hostmonit 的顺序与命名。
4. **管理页与 CSV**（§6）：上传什么文件、如何解析、名字怎么来。
5. **API**（§7）：程序化写入与设置；与页面「保存分组」等价的是 `POST /api/report`。

实现细节（Worker、KV、`src/shared/cfst.ts`）在对应章节用简短指针标出即可。

---

## 3. Scope

### In Scope

- 多租户；每租户一个原始订阅 URL、一个 access token、一个代理订阅 URL。
- 分组（group key / `ssid`）与可选 **alias**；每组下多条 **IP 条目**（`ip`、可选 `name`、以及测速附带字段）。
- 管理页：**CSV 导入**（[CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)、[montecarlo-ip-searcher (mcis)](https://github.com/Leo-Mu/montecarlo-ip-searcher)）、**手动**增删改、**保存**到服务端。
- **程序化**：`POST /api/report` 与页面保存等价；`PATCH /api/tenant/settings` 切换 Hostmonit 合并开关。
- 订阅扩展：租户级开关 **合并 Hostmonit**（数据来自 `get_optimization_ip` API；公开页面参考 [Hostmonit CloudFlareYes](https://stock.hostmonit.com/CloudFlareYes)）。
- 单协议场景：**VLESS + WS + TLS**，节点模板从原始订阅解析。

### Out of Scope

- 本站内嵌测速探针、多协议全兼容、多探针合并、历史分析面板、通用公开优选池（Hostmonit 仅为可选附加来源）。

### 第一版约束

- CSV 导入是**批量录入**，解析结果与手动条目在保存前统一为同一结构。
- 单租户至少能从原始订阅解析出一个有效 `vless://` 作为模板。

---

## 4. Core Model

### Tenant

- `tenantId`、`originSubscriptionUrl`、`originNodeTemplate`、`accessToken`、`originUrlHash`
- `aliases`：分组键 → 展示用 alias
- `topN`：CSV 导入后进入编辑器时截取前 N 条（默认 5，上限与实现一致）
- `subscriptionSources`：可选 `{ hostmonit?: boolean }`；未写入 KV 的旧租户视为全部关闭

当前实现：**同一 `accessToken`** 用于管理页、`/api/report`、订阅读取等（后续可演进读写分离）。

### Group Report（每组一条 KV）

- `ssid`（分组键）、可选 `alias`、`updatedAt`
- `results[]`：与下述条目结构一致

### Group Item（`SpeedTestResult`）

| 字段 | 说明 |
|------|------|
| `ip` | 必填（保存时）；订阅生成核心 |
| `name` | 可选；节点展示名，空则回退 `ip` |
| `latency` / `loss` / `speed` / `colo` | 可选；来自测速或 CSV，**不参与订阅连通性逻辑**，仅供展示或人工判断 |

说明：`loss` 在 **mcis 英文表头 CSV** 中仅当存在 **`loss` 列**时写入；不会用 `fail_prefix` 等字段冒充丢包率。

### Origin Node Template

从原始订阅提取：`uuid`、`port`、`host`、`sni`、`path`、`security`、`type` 等；生成时用条目替换 **`server`** 与节点名。

---

## 5. Subscription Output

### 输入侧

- 原始订阅解析出的模板 + 各分组已保存条目 +（可选）Hostmonit 条目列表。

### 输出行为

- 每个自建条目对应一条 `vless://`：保留模板参数，**仅将连接地址换为对应 IP**，名称按 §6.4 / 本节规则拼接。
- **Hostmonit**：仅在租户开启 `subscriptionSources.hostmonit` 时，在订阅**末尾**追加由 Hostmonit API 解析出的节点（名称含地区与线路等，由 `src/shared/hostmonit.ts` 规则生成）。
- 最终整体 **base64** 返回（与常见客户端导入格式一致）。

### 节点名（订阅中的最终串）

建议形式：`{aliasOrGroup}-{itemNameOrIp}`

- 前缀：有 alias 用 alias，否则用分组键。
- 后缀：条目 `name` 非空则用 `name`，否则用 `ip`。

示例：`Home-东京(NRT)-01`、`Cafe-104.16.1.1`。

---

## 6. 管理页：CSV、手动与扩展来源

### 6.1 主流程（与早期「Import CSV」条目对齐）

1. 用户持 `accessToken` 打开 `/dashboard/:tenantId?token=...`。
2. **分组名**：输入分组键（新建或覆盖同名分组）。
3. **录入方式三选一**：
   - 上传 **CFST** 默认 `result.csv` 或 **mcis** 的 `--out csv` 文件；
   - 点「手动开始」从空表填 IP；
   - 外部脚本调用 `POST /api/report`（与点「保存分组」等价）。
4. 导入 CSV 后进入**可编辑表格**，可改 IP/名称或增删行，再**保存**写入 KV。

说明：CSV 解析在浏览器内完成（`dashboardPage` 内嵌脚本）；共享逻辑与 `src/shared/cfst.ts` **语义对齐**，便于以后抽到单测。

### 6.2 官方对接的两种 CSV（面向用户说明）

| 工具 | 参考仓库 | 使用要点 |
|------|----------|----------|
| **CloudflareSpeedTest（CFST）** | [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) | 默认生成的 `result.csv` 即可（首行中文表头，数据列顺序固定）。 |
| **montecarlo-ip-searcher（mcis）** | [Leo-Mu/montecarlo-ip-searcher](https://github.com/Leo-Mu/montecarlo-ip-searcher) | 必须 **`--out csv`**，并用 **`--out-file`**（或等价参数）写出文件；否则默认可能是 text/jsonl。示例：`./mcis -v --out csv --out-file=result.csv --cidr-file ./ipv4cidr.txt --budget 3000 --concurrency 100` |

**其他格式**：不在上述两种之列时，请用「手动开始」或在表格中直接填写 **IP** 与 **名称**。

### 6.3 解析策略（实现摘要）

解析入口：`parseCfstCsv`（`src/shared/cfst.ts`）与管理页 `parseCsv` 行为一致。

1. **按列名解析（Named）**  
   当表头同时含 **`ip`**，且满足以下**任一**条件时走列名映射：
   - 含 **`download_mbps`**，或
   - 同时含 **`rank`** 与 **`score_ms`**，或
   - 同时含 **`rank`** 与 **`prefix`**（典型 mcis 导出）。

   并从列中读取：`ip`、`colo`、`download_mbps`（若无则用 `speed`）、可选 `line`（`CM`/`CU`/`CT`）、可选 `loss`（仅 `loss` 列）、`latency`（优先 `latency`，否则 `score_ms`、`total_ms`）。

2. **兜底**  
   若表头含 **`ip`** 且**第二行数据**形如「首列纯数字 rank、第二列 IPv4/IPv6」，**强制**走按列名解析，避免误走固定列把 **rank 当成 IP**（历史问题）。

3. **固定列（Legacy）**  
   首行任意表头，从**第二行**起数据列顺序为：  
   `ip, (skip×2), loss, latency, speed, colo, line?`  
   第 8 列可选运营商线路代码。与 **CFST `result.csv` 数据列**一致。

4. **固定列入口二次保险**  
   即使误判进入 Legacy，若检测到 rank+IP 形态，会**改走** Named 解析。

### 6.4 导入时自动生成的 `name`（表格中的「名字」列）

用于减少手工起名；保存后仍可与 §5 的分组前缀拼接成最终节点名。

- 有 **colo**：`地区中文(colo)·线路中文-序号`（线路列可选；无线路则为 `地区(colo)-序号`）。地区表见 `CF_COLO_REGION_ZH`（`src/shared/hostmonit.ts`）。
- 无 **colo**：仅用 **下载速度（MB）** 生成短名（如 `13MB-01`）；**不再用延迟**参与起名。
- 同组内同「基础串」多条时序号递增 `-01`、`-02`…

### 6.5 Hostmonit 扩展（管理页开关）

- 文案与说明页链接：[Hostmonit · CloudFlareYes](https://stock.hostmonit.com/CloudFlareYes)。
- 关闭：订阅仅含**原始模板节点**（按实现约定展示）+ **用户自建分组**节点。
- 开启：在订阅**末尾**追加 Hostmonit 返回的优选 IP 列表。
- 设置通过管理页勾选 + `PATCH /api/tenant/settings`（见 §7）。

---

## 7. APIs

### `POST /api/lookup`

根据用户粘贴的链接定位或创建租户。

请求体：`{ "url": "<原始订阅 URL 或本站 subscriptionUrl>" }`  
响应：`tenantId`、`accessToken`、`isNew`。  
前端随后跳转 `/dashboard/:tenantId?token=<accessToken>`。

### `POST /api/tenants`

显式创建租户；响应含 `dashboardUrl`、`subscriptionUrl`。

### `GET /dashboard/:tenantId`

Query：`token=<accessToken>`。返回 HTML 管理页。

### `POST /api/report`

保存某分组条目（与页面「保存分组」一致）。

Header：`Authorization: Bearer <accessToken>`

请求体示例：

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
    { "ip": "104.16.1.2" }
  ]
}
```

说明：字段名 `results` 为历史兼容；语义为「该分组当前用于生成订阅的条目列表」。

### `GET /api/groups` / `GET /api/group` / `DELETE /api/group`

Bearer 同上。`GET /api/group?group=<groupKey>` 返回该分组报告。

### `PATCH /api/tenant/settings`

更新租户可选设置（当前仅 **订阅扩展来源**）。

Header：`Authorization: Bearer <accessToken>`

请求体示例：

```json
{
  "subscriptionSources": {
    "hostmonit": true
  }
}
```

响应含 `ok` 与合并后的 `subscriptionSources`。

### `DELETE /api/tenant`

删除当前租户及全部数据（不可恢复）。Bearer 同上。

### `GET /sub/:tenantId`

Query：`token=<accessToken>`。返回 base64 代理订阅。

---

## 8. Architecture

- **Worker**：`src/worker/index.ts` — 路由、管理页 HTML、KV 读写、订阅拼装、Hostmonit 拉取与缓存。
- **Shared**：`src/shared/` — 类型、`vless` 解析与生成、`cfst` CSV 解析、`hostmonit` 响应解析与地区/线路文案。
- **Storage**：`KV` — 租户记录、分组报告；`Cache API` — Hostmonit 响应短期缓存（实现细节见代码）。

---

## 9. Grouping 补充

- 分组键为用户输入字符串；API 请求体仍可用历史字段名 `ssid`。
- 存储主键为原始分组键；alias 仅影响展示与节点名前缀，变更 alias 不迁移键名。

---

## 10. Security

- 原始订阅 URL、`accessToken` 视为敏感信息。
- 租户间数据隔离；拉取原始订阅需限制协议与行为，避免 SSRF。

---

## 11. Recommended Project Layout

```text
src/
  worker/
  shared/
SPEC.md
```

---

## 12. Milestones & Success Criteria

### Milestones（简写）

- M1：租户创建、模板解析、固定订阅 URL。
- M2：管理页 CSV + 保存分组。
- M3：手动编辑、多分组聚合、客户端可导入。

### 成功标准

- 用户拿到代理订阅 URL 与管理链接后，能通过 **CSV / 手动 / API** 维护分组。
- 订阅中节点名符合分组与条目规则；模板仅替换 IP。
- 可选 Hostmonit 在末尾追加且可通过设置关闭。
