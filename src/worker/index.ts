import type {
  CreateTenantInput,
  CreateTenantOutput,
  GroupSummary,
  LookupInput,
  LookupOutput,
  OriginNodeTemplate,
  ReportPayload,
  SsidReport,
  TenantRecord,
} from "../shared/types.js";
import { buildSubscriptionLines, encodeSubscription, extractFirstVlessTemplate } from "../shared/vless.js";

export interface Env {
  TENANTS: KVNamespace;
  REPORTS: KVNamespace;
}

export interface SubscriptionContext {
  template: OriginNodeTemplate;
  reports: SsidReport[];
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

const htmlHeaders = {
  "content-type": "text/html; charset=utf-8",
};

const textHeaders = {
  "content-type": "text/plain; charset=utf-8",
};

export function renderSubscription(context: SubscriptionContext): string {
  const lines = buildSubscriptionLines(context.template, context.reports);
  return encodeSubscription(lines);
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      ...jsonHeaders,
      ...(init?.headers ?? {}),
    },
  });
}

function html(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: {
      ...htmlHeaders,
      ...(init?.headers ?? {}),
    },
  });
}

function text(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    ...init,
    headers: {
      ...textHeaders,
      ...(init?.headers ?? {}),
    },
  });
}

function errorResponse(status: number, message: string): Response {
  return json({ error: message }, { status });
}

function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function getTenantKey(tenantId: string): string {
  return `tenant:${tenantId}`;
}

function getOriginHashKey(hash: string): string {
  return `originUrlHash:${hash}`;
}

function getReportKey(tenantId: string, group: string): string {
  return `report:${tenantId}:${group}`;
}

async function hashUrl(url: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(url);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeOriginSubscriptionUrl(input: string): string {
  const url = new URL(input);
  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new Error("订阅链接必须使用 https");
  }
  return url.toString();
}

function parseBearerToken(request: Request): string {
  const authHeader = request.headers.get("authorization") ?? "";
  const [scheme, token] = authHeader.split(" ");

  if (scheme !== "Bearer" || !token) {
    throw new Error("Missing Bearer token");
  }

  return token;
}

function extractTenantIdFromToken(token: string): string {
  const [tenantId] = token.split(".");
  if (!tenantId?.startsWith("t_")) {
    throw new Error("Invalid token format");
  }
  return tenantId;
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

async function getTenant(env: Env, tenantId: string): Promise<TenantRecord | null> {
  return env.TENANTS.get<TenantRecord>(getTenantKey(tenantId), "json");
}

async function requireTenant(env: Env, tenantId: string): Promise<TenantRecord> {
  const tenant = await getTenant(env, tenantId);
  if (!tenant) {
    throw new Error("Tenant not found");
  }
  return tenant;
}

async function getTenantByOriginHash(env: Env, hash: string): Promise<string | null> {
  return env.TENANTS.get(getOriginHashKey(hash));
}

async function fetchOriginSubscriptionTemplate(originSubscriptionUrl: string): Promise<OriginNodeTemplate> {
  const response = await fetch(originSubscriptionUrl, {
    headers: {
      "user-agent": "cf-ip-choose/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`无法获取原始订阅: HTTP ${response.status}`);
  }

  const subscriptionText = await response.text();
  return extractFirstVlessTemplate(subscriptionText);
}

function isOurSubscriptionUrl(inputUrl: string, requestOrigin: string): boolean {
  try {
    const parsed = new URL(inputUrl);
    const origin = new URL(requestOrigin);
    return parsed.hostname === origin.hostname && parsed.pathname.startsWith("/sub/");
  } catch {
    return false;
  }
}

function parseOurSubscriptionUrl(inputUrl: string): { tenantId: string; token: string } | null {
  try {
    const parsed = new URL(inputUrl);
    const match = parsed.pathname.match(/^\/sub\/([^/]+)$/);
    if (!match) return null;
    const tenantId = match[1];
    const token = parsed.searchParams.get("token");
    if (!tenantId || !token) return null;
    return { tenantId, token };
  } catch {
    return null;
  }
}

async function createNewTenant(
  env: Env,
  originSubscriptionUrl: string,
  origin: string,
): Promise<{ tenant: TenantRecord; isNew: true }> {
  const normalizedUrl = normalizeOriginSubscriptionUrl(originSubscriptionUrl);
  const originNodeTemplate = await fetchOriginSubscriptionTemplate(normalizedUrl);
  const tenantId = makeId("t");
  const accessToken = `${tenantId}.${makeId("access")}`;
  const originUrlHash = await hashUrl(normalizedUrl);

  const record: TenantRecord = {
    tenantId,
    originSubscriptionUrl: normalizedUrl,
    originNodeTemplate,
    accessToken,
    originUrlHash,
    aliases: {},
    topN: 5,
    createdAt: new Date().toISOString(),
  };

  await Promise.all([
    env.TENANTS.put(getTenantKey(tenantId), JSON.stringify(record)),
    env.TENANTS.put(getOriginHashKey(originUrlHash), tenantId),
  ]);

  return { tenant: record, isNew: true };
}

async function lookupOrCreateTenant(
  request: Request,
  env: Env,
): Promise<LookupOutput> {
  const body = await readJson<LookupInput>(request);
  const inputUrl = body.url?.trim();

  if (!inputUrl) {
    throw new Error("请输入订阅链接");
  }

  const origin = new URL(request.url).origin;

  if (isOurSubscriptionUrl(inputUrl, origin)) {
    const parsed = parseOurSubscriptionUrl(inputUrl);
    if (!parsed) {
      throw new Error("无效的订阅链接格式");
    }

    const tenant = await getTenant(env, parsed.tenantId);
    if (!tenant) {
      throw new Error("找不到对应的配置，请使用原始订阅链接重新创建");
    }

    if (tenant.accessToken !== parsed.token) {
      throw new Error("访问令牌无效");
    }

    return {
      tenantId: tenant.tenantId,
      accessToken: tenant.accessToken,
      isNew: false,
    };
  }

  const normalizedUrl = normalizeOriginSubscriptionUrl(inputUrl);
  const urlHash = await hashUrl(normalizedUrl);
  const existingTenantId = await getTenantByOriginHash(env, urlHash);

  if (existingTenantId) {
    const tenant = await getTenant(env, existingTenantId);
    if (tenant) {
      return {
        tenantId: tenant.tenantId,
        accessToken: tenant.accessToken,
        isNew: false,
      };
    }
  }

  const { tenant } = await createNewTenant(env, normalizedUrl, origin);
  return {
    tenantId: tenant.tenantId,
    accessToken: tenant.accessToken,
    isNew: true,
  };
}

async function createTenantRecord(
  request: Request,
  env: Env,
): Promise<CreateTenantOutput> {
  const body = await readJson<CreateTenantInput>(request);
  const origin = new URL(request.url).origin;
  const { tenant } = await createNewTenant(env, body.originSubscriptionUrl, origin);

  return {
    tenantId: tenant.tenantId,
    accessToken: tenant.accessToken,
    dashboardUrl: `${origin}/dashboard/${tenant.tenantId}?token=${tenant.accessToken}`,
    subscriptionUrl: `${origin}/sub/${tenant.tenantId}?token=${tenant.accessToken}`,
  };
}

async function saveReport(request: Request, env: Env): Promise<Response> {
  const token = parseBearerToken(request);
  const tenantId = extractTenantIdFromToken(token);
  const tenant = await requireTenant(env, tenantId);

  if (tenant.accessToken !== token) {
    return errorResponse(401, "访问令牌无效");
  }

  const body = await readJson<ReportPayload>(request);
  if (!body.ssid?.trim()) {
    return errorResponse(400, "分组名 (ssid) 不能为空");
  }

  const report: SsidReport = {
    ssid: body.ssid.trim(),
    alias: body.alias?.trim() || tenant.aliases[body.ssid.trim()],
    updatedAt: body.updatedAt || new Date().toISOString(),
    results: body.results.slice(0, tenant.topN),
  };

  await env.REPORTS.put(getReportKey(tenantId, report.ssid), JSON.stringify(report));

  return json({
    ok: true,
    tenantId,
    group: report.ssid,
    count: report.results.length,
  });
}

async function loadReports(env: Env, tenantId: string): Promise<SsidReport[]> {
  const list = await env.REPORTS.list({ prefix: `report:${tenantId}:` });
  const reports = await Promise.all(
    list.keys.map((key) => env.REPORTS.get<SsidReport>(key.name, "json")),
  );

  return reports
    .filter((report): report is SsidReport => Boolean(report))
    .sort((a, b) => {
      const left = a.alias || a.ssid;
      const right = b.alias || b.ssid;
      return left.localeCompare(right);
    });
}

async function getGroups(request: Request, env: Env): Promise<Response> {
  const token = parseBearerToken(request);
  const tenantId = extractTenantIdFromToken(token);
  const tenant = await requireTenant(env, tenantId);

  if (tenant.accessToken !== token) {
    return errorResponse(401, "访问令牌无效");
  }

  const reports = await loadReports(env, tenantId);
  const groups: GroupSummary[] = reports.map((r) => ({
    group: r.ssid,
    alias: r.alias,
    count: r.results.length,
    updatedAt: r.updatedAt,
    topColo: r.results[0]?.colo,
  }));

  return json({ groups });
}

async function getProxySubscription(request: Request, env: Env, tenantId: string): Promise<Response> {
  const tenant = await requireTenant(env, tenantId);
  const token = new URL(request.url).searchParams.get("token");

  if (token !== tenant.accessToken) {
    return errorResponse(401, "访问令牌无效");
  }

  const reports = await loadReports(env, tenantId);
  const subscription = renderSubscription({
    template: tenant.originNodeTemplate,
    reports,
  });

  return text(subscription);
}

function landingPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>CF IP Choose</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 60px auto; padding: 0 20px; line-height: 1.6; }
      h1 { text-align: center; margin-bottom: 8px; }
      .subtitle { text-align: center; color: #666; margin-bottom: 40px; }
      .card { border: 1px solid #ddd; border-radius: 12px; padding: 24px; background: #fafafa; }
      @media (prefers-color-scheme: dark) { .card { background: #1a1a1a; border-color: #333; } }
      label { display: block; margin-bottom: 8px; font-weight: 500; }
      input { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 16px; margin-bottom: 16px; }
      @media (prefers-color-scheme: dark) { input { background: #222; border-color: #444; color: #fff; } }
      button { width: 100%; padding: 14px; background: #0070f3; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
      button:hover { background: #0060df; }
      button:disabled { background: #999; cursor: not-allowed; }
      .hint { font-size: 14px; color: #888; margin-top: 12px; }
      .error { color: #e00; margin-top: 12px; }
    </style>
  </head>
  <body>
    <h1>CF IP Choose</h1>
    <p class="subtitle">Cloudflare IP 优选服务</p>
    <div class="card">
      <form id="lookup-form">
        <label for="url">粘贴你的订阅链接</label>
        <input id="url" name="url" type="url" placeholder="https://example.com/sub/xxx" required />
        <button type="submit" id="submit-btn">进入管理</button>
      </form>
      <p class="hint">支持：原始订阅链接 或 本站生成的优选订阅链接</p>
      <p class="error" id="error" style="display:none;"></p>
    </div>
    <script>
      const form = document.getElementById("lookup-form");
      const submitBtn = document.getElementById("submit-btn");
      const errorEl = document.getElementById("error");

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        errorEl.style.display = "none";
        submitBtn.disabled = true;
        submitBtn.textContent = "处理中...";

        try {
          const url = document.getElementById("url").value;
          const resp = await fetch("/api/lookup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url })
          });
          const data = await resp.json();
          if (!resp.ok) {
            throw new Error(data.error || "请求失败");
          }
          window.location.href = "/dashboard/" + data.tenantId + "?token=" + data.accessToken;
        } catch (err) {
          errorEl.textContent = err.message;
          errorEl.style.display = "block";
          submitBtn.disabled = false;
          submitBtn.textContent = "进入管理";
        }
      });
    </script>
  </body>
</html>`;
}

function dashboardPage(origin: string, tenantId: string, accessToken: string): string {
  const subscriptionUrl = `${origin}/sub/${tenantId}?token=${accessToken}`;
  const dashboardUrl = `${origin}/dashboard/${tenantId}?token=${accessToken}`;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>管理面板 - CF IP Choose</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
      h1 { margin-bottom: 8px; }
      .subtitle { color: #666; margin-bottom: 32px; }
      .section { border: 1px solid #ddd; border-radius: 12px; padding: 20px; margin-bottom: 20px; background: #fafafa; }
      @media (prefers-color-scheme: dark) { .section { background: #1a1a1a; border-color: #333; } }
      .section-title { font-weight: 600; margin-bottom: 12px; }
      .url-box { display: flex; gap: 8px; }
      .url-input { flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; font-family: monospace; }
      @media (prefers-color-scheme: dark) { .url-input { background: #222; border-color: #444; color: #fff; } }
      .copy-btn { padding: 10px 16px; background: #0070f3; color: white; border: none; border-radius: 6px; cursor: pointer; white-space: nowrap; }
      .copy-btn:hover { background: #0060df; }
      .upload-form { display: grid; gap: 12px; }
      .form-row { display: flex; gap: 12px; align-items: end; }
      .form-group { flex: 1; }
      .form-group label { display: block; margin-bottom: 6px; font-size: 14px; }
      .form-group input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
      @media (prefers-color-scheme: dark) { .form-group input { background: #222; border-color: #444; color: #fff; } }
      .upload-btn { padding: 10px 20px; background: #10b981; color: white; border: none; border-radius: 6px; cursor: pointer; }
      .upload-btn:hover { background: #059669; }
      .upload-btn:disabled { background: #999; cursor: not-allowed; }
      .groups-list { margin-top: 12px; }
      .group-item { display: flex; justify-content: space-between; padding: 12px; border-bottom: 1px solid #eee; }
      @media (prefers-color-scheme: dark) { .group-item { border-color: #333; } }
      .group-item:last-child { border-bottom: none; }
      .group-name { font-weight: 500; }
      .group-meta { color: #666; font-size: 14px; }
      .empty { color: #888; text-align: center; padding: 20px; }
      .message { padding: 12px; border-radius: 6px; margin-top: 12px; }
      .message.success { background: #d1fae5; color: #065f46; }
      .message.error { background: #fee2e2; color: #991b1b; }
      @media (prefers-color-scheme: dark) { 
        .message.success { background: #064e3b; color: #6ee7b7; }
        .message.error { background: #7f1d1d; color: #fca5a5; }
      }
      .back-link { display: inline-block; margin-bottom: 20px; color: #0070f3; text-decoration: none; }
      .back-link:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <a href="/" class="back-link">← 返回首页</a>
    <h1>管理面板</h1>
    <p class="subtitle">管理你的 Cloudflare IP 优选配置</p>

    <div class="section">
      <div class="section-title">优选订阅链接</div>
      <div class="url-box">
        <input type="text" class="url-input" id="sub-url" value="${subscriptionUrl}" readonly />
        <button class="copy-btn" onclick="copyUrl('sub-url')">复制</button>
      </div>
      <p style="font-size:13px;color:#888;margin-top:8px;">将此链接导入代理客户端（如 Hiddify）即可使用优选 IP</p>
    </div>

    <div class="section">
      <div class="section-title">管理链接</div>
      <div class="url-box">
        <input type="text" class="url-input" id="dash-url" value="${dashboardUrl}" readonly />
        <button class="copy-btn" onclick="copyUrl('dash-url')">复制</button>
      </div>
      <p style="font-size:13px;color:#888;margin-top:8px;">保存此链接，下次可直接进入管理页面</p>
    </div>

    <div class="section">
      <div class="section-title">上传测速结果</div>
      <form class="upload-form" id="upload-form">
        <div class="form-row">
          <div class="form-group">
            <label for="group-name">分组名</label>
            <input type="text" id="group-name" placeholder="例如: home, office" required />
          </div>
          <div class="form-group">
            <label for="csv-file">CSV 文件</label>
            <input type="file" id="csv-file" accept=".csv" required />
          </div>
          <button type="submit" class="upload-btn" id="upload-btn">上传</button>
        </div>
      </form>
      <div id="upload-message"></div>
    </div>

    <div class="section">
      <div class="section-title">已上传分组</div>
      <div id="groups-container">
        <div class="empty">加载中...</div>
      </div>
    </div>

    <script>
      const ACCESS_TOKEN = "${accessToken}";
      const TENANT_ID = "${tenantId}";

      function copyUrl(id) {
        const input = document.getElementById(id);
        navigator.clipboard.writeText(input.value);
        const btn = input.nextElementSibling;
        btn.textContent = "已复制";
        setTimeout(() => btn.textContent = "复制", 1500);
      }

      function parseNumber(val) {
        const n = Number(val);
        return Number.isFinite(n) ? n : 0;
      }

      function parseCsv(text) {
        const lines = text.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length <= 1) return [];
        return lines.slice(1).map(line => {
          const [ip, , , loss, latency, speed, colo] = line.split(",");
          return { ip, loss: parseNumber(loss), latency: parseNumber(latency), speed: parseNumber(speed), colo: colo || undefined };
        }).filter(r => r.ip);
      }

      function pickTop(results, n = 5) {
        return results.slice(0, n);
      }

      function formatTime(iso) {
        const d = new Date(iso);
        const now = Date.now();
        const diff = now - d.getTime();
        if (diff < 60000) return "刚刚";
        if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
        if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
        return Math.floor(diff / 86400000) + " 天前";
      }

      async function loadGroups() {
        const container = document.getElementById("groups-container");
        try {
          const resp = await fetch("/api/groups", {
            headers: { "Authorization": "Bearer " + ACCESS_TOKEN }
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error);
          
          if (!data.groups || data.groups.length === 0) {
            container.innerHTML = '<div class="empty">暂无分组，请上传测速结果</div>';
            return;
          }

          container.innerHTML = '<div class="groups-list">' + data.groups.map(g => 
            '<div class="group-item">' +
              '<div><span class="group-name">' + (g.alias || g.group) + '</span>' +
                (g.alias ? ' <span style="color:#888">(' + g.group + ')</span>' : '') +
              '</div>' +
              '<div class="group-meta">' + g.count + ' 个 IP · ' + (g.topColo || '-') + ' · ' + formatTime(g.updatedAt) + '</div>' +
            '</div>'
          ).join("") + '</div>';
        } catch (err) {
          container.innerHTML = '<div class="empty" style="color:#e00;">加载失败: ' + err.message + '</div>';
        }
      }

      document.getElementById("upload-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = document.getElementById("upload-btn");
        const msgEl = document.getElementById("upload-message");
        btn.disabled = true;
        btn.textContent = "上传中...";
        msgEl.innerHTML = "";

        try {
          const groupName = document.getElementById("group-name").value.trim();
          const file = document.getElementById("csv-file").files[0];
          
          if (!groupName) throw new Error("请输入分组名");
          if (!file) throw new Error("请选择 CSV 文件");

          const text = await file.text();
          const results = parseCsv(text);
          if (results.length === 0) throw new Error("CSV 中没有有效数据");

          const topResults = pickTop(results, 5);
          const payload = {
            ssid: groupName,
            updatedAt: new Date().toISOString(),
            results: topResults
          };

          const resp = await fetch("/api/report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + ACCESS_TOKEN
            },
            body: JSON.stringify(payload)
          });

          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error);

          msgEl.innerHTML = '<div class="message success">上传成功！已保存 ' + data.count + ' 个 IP</div>';
          document.getElementById("group-name").value = "";
          document.getElementById("csv-file").value = "";
          loadGroups();
        } catch (err) {
          msgEl.innerHTML = '<div class="message error">' + err.message + '</div>';
        } finally {
          btn.disabled = false;
          btn.textContent = "上传";
        }
      });

      loadGroups();
    </script>
  </body>
</html>`;
}

async function serveDashboard(request: Request, env: Env, tenantId: string): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return errorResponse(401, "缺少访问令牌");
  }

  const tenant = await getTenant(env, tenantId);
  if (!tenant) {
    return errorResponse(404, "找不到对应的配置");
  }

  if (tenant.accessToken !== token) {
    return errorResponse(401, "访问令牌无效");
  }

  const origin = new URL(request.url).origin;
  return html(dashboardPage(origin, tenantId, token));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return html(landingPage());
      }

      if (request.method === "POST" && url.pathname === "/api/lookup") {
        const result = await lookupOrCreateTenant(request, env);
        return json(result);
      }

      if (request.method === "POST" && url.pathname === "/api/tenants") {
        const result = await createTenantRecord(request, env);
        return json(result, { status: 201 });
      }

      if (request.method === "POST" && url.pathname === "/api/report") {
        return await saveReport(request, env);
      }

      if (request.method === "GET" && url.pathname === "/api/groups") {
        return await getGroups(request, env);
      }

      if (request.method === "GET" && url.pathname.startsWith("/dashboard/")) {
        const tenantId = url.pathname.slice("/dashboard/".length);
        if (!tenantId) {
          return errorResponse(400, "Missing tenantId");
        }
        return await serveDashboard(request, env, tenantId);
      }

      if (request.method === "GET" && url.pathname.startsWith("/sub/")) {
        const tenantId = url.pathname.slice("/sub/".length);
        if (!tenantId) {
          return errorResponse(400, "Missing tenantId");
        }
        return await getProxySubscription(request, env, tenantId);
      }

      return errorResponse(404, "Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return errorResponse(400, message);
    }
  },
};
