# cf-sub-optimizer

基于 Cloudflare Worker 的多租户 **Cloudflare IP 优选订阅**：从原始订阅里抽出节点模板，按你在管理页维护的多组优选 IP 动态生成一条 **base64 代理订阅**。

## 在线使用（维护者实例）

已部署实例：**<https://cf-sub-optimizer.basilfield.com>**

1. 打开首页，粘贴 **原始 https 订阅**、**单条 `vless://` 节点链接**，或本站生成的优选订阅链接。  
2. 进入管理页后，可导入 [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 的 CSV、手动增删 IP，并按分组保存。  
3. 将页面上的 **优选订阅链接** 导入你常用的代理客户端即可。

输出为标准的多行 `vless://` 再 base64，**凡能导入此类订阅的客户端均可使用**；实现上当前模板来自订阅中的 **VLESS + WS + TLS** 节点（与多数“优选 IP + 固定模板”场景一致）。

## 特点：多地点测速，分组一起管

Cloudflare 优选结果强依赖 **你测速时的网络位置**。家里、公司、不同城市各跑一轮测速，会得到不同的一批 IP。

本服务的侧重点是把 **多套测速结果用「分组」收拢**：每组对应一个环境或一条测速记录，订阅里节点名带 **分组前缀（或 alias）**，在客户端里能一眼区分「家宽 / 办公室 / 出差」等，而不必为每个环境维护一堆手工改过的订阅文件。

## 自己部署

若你希望 **自有域名**、**数据与 Worker 完全自控**，或要调整 KV / 路由等配置，可自行部署：

- 需要：Node.js、npm、Cloudflare 账号、Wrangler（本项目已作为 devDependency）、两个 KV 命名空间（`TENANTS`、`REPORTS`）。  
- 将 `wrangler.toml` 中的 KV ID、路由或 `custom_domain` 改成你的环境。  
- 常用命令：`npm install` → `npm run check` → `npm run worker:deploy`；本地调试：`npm run worker:dev`。

接口清单、数据模型、行为约束与推荐目录结构见 **[SPEC.md](./SPEC.md)**。

## 相关工具

- [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)：生成可导入的测速 CSV。

## License

[MIT](./LICENSE)
