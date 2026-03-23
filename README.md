# cf-sub-optimizer

基于 Cloudflare Worker 的多租户 **Cloudflare IP 优选订阅**：从你提供的原始订阅里取出节点模板，按管理页里维护的多组优选 IP，动态生成一条 **base64 代理订阅**（标准多行 `vless://`）。

## 在线使用

已部署实例：**<https://cf-sub-optimizer.basilfield.com>**

1. 打开首页，粘贴 **原始 HTTPS 订阅**、**单条 `vless://` 链接**，或本站返回的 **优选订阅链接**，进入管理页。  
2. 按「分组」维护 IP：可 **上传测速 CSV**、**手动填写**，或通过 **API** 写入（与页面保存效果相同，详见 [SPEC.md](./SPEC.md)）。  
3. 将页面上的 **优选订阅链接** 导入常用代理客户端即可。

### 测速 CSV（直接上传即可）

- **[CloudflareSpeedTest（CFST）](https://github.com/XIU2/CloudflareSpeedTest)**：使用默认生成的 `result.csv`。  
- **[montecarlo-ip-searcher（mcis）](https://github.com/Leo-Mu/montecarlo-ip-searcher)**：需使用 **`--out csv`** 和 **`--out-file`** 写出 CSV，例如：  
  `./mcis -v --out csv --out-file=result.csv --cidr-file ./ipv4cidr.txt --budget 3000 --concurrency 100`  

其他来源可在管理页表格里 **手动输入 IP 与节点名称**。导入后会根据测速结果 **自动生成显示名**，你仍可随时修改。

### 可选：合并 Hostmonit 优选 IP

管理页可勾选 **合并 Hostmonit 公开优选 IP**，开启后会在订阅 **末尾** 追加第三方维护的列表（与自建分组独立）。说明与数据来源可参考 [Hostmonit · CloudFlareYes](https://stock.hostmonit.com/CloudFlareYes)。

## 为什么用「分组」

Cloudflare 优选结果和 **你测速时的网络环境** 强相关。家里、公司、不同城市各测一轮，往往得到不同的一批 IP。

本服务把多套结果用 **分组** 收拢：每组对应一个场景或一次测速，订阅里节点名带 **分组名或别名（alias）**，在客户端里能区分「家宽 / 办公室」等，而不必为每个环境单独维护改好的订阅文件。

## 技术说明（简）

- 当前模板来自原始订阅中的 **VLESS + WS + TLS** 节点；生成时主要替换 **连接 IP** 与节点显示名。  
- **凡能导入 base64 `vless://` 订阅的客户端均可使用**（文档常以 Hiddify 为例）。  
- 完整接口、数据结构与行为约定见 **[SPEC.md](./SPEC.md)**。

## 自己部署

适合需要 **自有域名**、**数据与 Worker 完全自控** 或要改 KV / 路由的场景：

- 环境：Node.js、npm、Cloudflare 账号、Wrangler（本项目 devDependency）、两个 KV 命名空间（`TENANTS`、`REPORTS`）。  
- 修改 `wrangler.toml` 中的 KV ID、路由或 `custom_domain`。  
- 常用命令：`npm install` → `npm run check` → `npm run worker:deploy`；本地调试：`npm run worker:dev`。

## License

[MIT](./LICENSE)
