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
import { buildSubscriptionLines, encodeSubscription, extractFirstVlessTemplate, parseVlessUrl } from "../shared/vless.js";

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

function normalizeOriginSubscriptionUrl(input: string, options?: { preserveHash?: boolean }): string {
  const url = new URL(input.trim());

  if (url.protocol === "vless:") {
    if (!options?.preserveHash) {
      url.hash = "";
    }
    return url.toString();
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new Error("订阅链接必须使用 https，或直接提供 vless:// 节点链接");
  }
  if (!options?.preserveHash) {
    url.hash = "";
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

async function migrateTenantOriginHash(
  env: Env,
  tenant: TenantRecord,
  normalizedUrl: string,
  normalizedHash: string,
): Promise<TenantRecord> {
  if (tenant.originUrlHash === normalizedHash && tenant.originSubscriptionUrl === normalizedUrl) {
    return tenant;
  }

  const migrated: TenantRecord = {
    ...tenant,
    originSubscriptionUrl: normalizedUrl,
    originUrlHash: normalizedHash,
  };

  await Promise.all([
    env.TENANTS.put(getTenantKey(tenant.tenantId), JSON.stringify(migrated)),
    env.TENANTS.put(getOriginHashKey(normalizedHash), tenant.tenantId),
  ]);

  return migrated;
}

/** 客户端（Clash / Hiddify 等）从原始订阅 HTTP 响应里读这些头展示流量与到期时间；代理订阅需回传。 */
const ORIGIN_SUBSCRIPTION_PASSTHROUGH_HEADER_NAMES = [
  "subscription-userinfo",
  "profile-update-interval",
  "profile-web-page-url",
] as const;

async function fetchOriginSubscriptionTemplate(originSubscriptionUrl: string): Promise<OriginNodeTemplate> {
  if (originSubscriptionUrl.startsWith("vless://")) {
    return parseVlessUrl(originSubscriptionUrl);
  }

  const response = await fetch(originSubscriptionUrl, {
    headers: {
      "user-agent": "cf-sub-optimizer/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`无法获取原始订阅: HTTP ${response.status}`);
  }

  const subscriptionText = await response.text();
  return extractFirstVlessTemplate(subscriptionText);
}

/** 向原始订阅发一次轻量 GET，仅取出用量相关响应头；失败时返回空，不影响主订阅正文。 */
async function fetchOriginSubscriptionPassthroughHeaders(originSubscriptionUrl: string): Promise<Headers> {
  const out = new Headers();
  if (originSubscriptionUrl.startsWith("vless:")) {
    return out;
  }

  try {
    const response = await fetch(originSubscriptionUrl, {
      headers: {
        "user-agent": "cf-sub-optimizer/0.1",
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      return out;
    }

    for (const name of ORIGIN_SUBSCRIPTION_PASSTHROUGH_HEADER_NAMES) {
      const value = response.headers.get(name);
      if (value) {
        out.set(name, value);
      }
    }
  } catch {
    // 上游不可达或超时时仍返回优化后的订阅正文，只是本周期无用量头
  }

  return out;
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
  _origin: string,
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
      throw new Error("找不到对应的配置，请使用原始 https 订阅链接或 vless:// 节点链接重新创建");
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
  let existingTenantId = await getTenantByOriginHash(env, urlHash);

  if (!existingTenantId) {
    const legacyUrl = normalizeOriginSubscriptionUrl(inputUrl, { preserveHash: true });
    if (legacyUrl !== normalizedUrl) {
      const legacyHash = await hashUrl(legacyUrl);
      existingTenantId = await getTenantByOriginHash(env, legacyHash);

      if (existingTenantId) {
        const legacyTenant = await getTenant(env, existingTenantId);
        if (legacyTenant) {
          const migratedTenant = await migrateTenantOriginHash(env, legacyTenant, normalizedUrl, urlHash);
          return {
            tenantId: migratedTenant.tenantId,
            accessToken: migratedTenant.accessToken,
            isNew: false,
          };
        }
      }
    }
  }

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

function normalizeReportResults(results: ReportPayload["results"]): SsidReport["results"] {
  const normalized: SsidReport["results"] = [];

  for (const item of results) {
    const ip = item.ip?.trim();
    if (!ip) {
      continue;
    }

    normalized.push({
      ip,
      name: item.name?.trim() || undefined,
      latency: item.latency,
      loss: item.loss,
      speed: item.speed,
      colo: item.colo?.trim() || undefined,
    });
  }

  return normalized;
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

  const normalizedResults = normalizeReportResults(body.results ?? []);
  if (normalizedResults.length === 0) {
    return errorResponse(400, "至少需要一个有效 IP");
  }

  const report: SsidReport = {
    ssid: body.ssid.trim(),
    alias: body.alias?.trim() || tenant.aliases[body.ssid.trim()],
    updatedAt: body.updatedAt || new Date().toISOString(),
    results: normalizedResults,
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

async function getGroupReport(request: Request, env: Env): Promise<Response> {
  const token = parseBearerToken(request);
  const tenantId = extractTenantIdFromToken(token);
  const tenant = await requireTenant(env, tenantId);

  if (tenant.accessToken !== token) {
    return errorResponse(401, "访问令牌无效");
  }

  const group = new URL(request.url).searchParams.get("group")?.trim();
  if (!group) {
    return errorResponse(400, "缺少分组名");
  }

  const report = await env.REPORTS.get<SsidReport>(getReportKey(tenantId, group), "json");
  if (!report) {
    return errorResponse(404, "找不到对应分组");
  }

  return json({ report });
}

async function deleteGroup(request: Request, env: Env): Promise<Response> {
  const token = parseBearerToken(request);
  const tenantId = extractTenantIdFromToken(token);
  const tenant = await requireTenant(env, tenantId);

  if (tenant.accessToken !== token) {
    return errorResponse(401, "访问令牌无效");
  }

  const group = new URL(request.url).searchParams.get("group")?.trim();
  if (!group) {
    return errorResponse(400, "缺少分组名");
  }

  await env.REPORTS.delete(getReportKey(tenantId, group));

  if (tenant.aliases?.[group]) {
    const nextAliases = { ...tenant.aliases };
    delete nextAliases[group];
    const updated: TenantRecord = { ...tenant, aliases: nextAliases };
    await env.TENANTS.put(getTenantKey(tenantId), JSON.stringify(updated));
  }

  return json({ ok: true, group });
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

  const passthrough = await fetchOriginSubscriptionPassthroughHeaders(tenant.originSubscriptionUrl);
  const headers = new Headers(textHeaders);
  passthrough.forEach((value, key) => {
    headers.set(key, value);
  });

  return new Response(subscription, { headers });
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
        <label for="url">粘贴你的订阅链接或 VLESS 单节点链接</label>
        <input id="url" name="url" type="text" placeholder="https://example.com/sub/xxx 或 vless://uuid@host:443?..." required />
        <button type="submit" id="submit-btn">进入管理</button>
      </form>
      <p class="hint">支持：原始 https 订阅链接、单条 vless:// 节点链接，或本站生成的优选订阅链接</p>
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
          const message = err instanceof Error ? err.message : String(err);
          errorEl.textContent = message;
          errorEl.style.display = "block";
          submitBtn.disabled = false;
          submitBtn.textContent = "进入管理";
        }
      });
    </script>
  </body>
</html>`;
}

function dashboardPage(
  origin: string,
  tenantId: string,
  accessToken: string,
  originSubscriptionUrl: string,
  topN: number,
): string {
  const subscriptionUrl = `${origin}/sub/${tenantId}?token=${accessToken}`;
  const dashboardUrl = `${origin}/dashboard/${tenantId}?token=${accessToken}`;
  const escAttr = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>管理面板 - CF IP Choose</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
      h1 { margin-bottom: 8px; }
      .subtitle { color: #666; margin-bottom: 32px; }
      .section { border: 1px solid #ddd; border-radius: 12px; padding: 20px; margin-bottom: 20px; background: #fafafa; }
      @media (prefers-color-scheme: dark) { .section { background: #1a1a1a; border-color: #333; } }
      .section-title { font-weight: 600; margin-bottom: 12px; }
      .url-box { display: flex; gap: 8px; }
      .url-input { flex: 1; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; font-family: monospace; }
      .copy-btn, .secondary-btn, .danger-btn, .upload-btn, .group-btn { padding: 10px 16px; color: white; border: none; border-radius: 6px; cursor: pointer; white-space: nowrap; }
      .copy-btn { background: #0070f3; }
      .copy-btn:hover { background: #0060df; }
      .upload-btn { background: #10b981; }
      .upload-btn:hover { background: #059669; }
      .secondary-btn { background: #6b7280; }
      .secondary-btn:hover { background: #4b5563; }
      .danger-btn { background: #dc2626; }
      .danger-btn:hover { background: #b91c1c; }
      .group-btn { background: #2563eb; }
      .group-btn:hover { background: #1d4ed8; }
      .copy-btn:disabled, .secondary-btn:disabled, .danger-btn:disabled, .upload-btn:disabled, .group-btn:disabled { background: #999; cursor: not-allowed; }
      .upload-form { display: grid; gap: 12px; }
      .form-row { display: flex; gap: 12px; align-items: end; }
      .form-group { flex: 1; }
      .form-group label { display: block; margin-bottom: 6px; font-size: 14px; }
      .form-group input, .table-input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
      @media (prefers-color-scheme: dark) { .url-input, .form-group input, .table-input { background: #222; border-color: #444; color: #fff; } }
      .groups-list { margin-top: 12px; }
      .group-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px; border-bottom: 1px solid #eee; }
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
      .edit-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; }
      .edit-grid { overflow-x: auto; }
      .edit-table { width: 100%; border-collapse: collapse; }
      .edit-table th, .edit-table td { padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }
      @media (prefers-color-scheme: dark) { .edit-table th, .edit-table td { border-color: #333; } }
      .table-hint { color: #888; font-size: 13px; margin-bottom: 12px; }
      .edit-actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <a href="/" class="back-link">← 返回首页</a>
    <h1>管理面板</h1>
    <p class="subtitle">管理你的 Cloudflare IP 优选配置</p>
    <div style="margin-bottom: 20px;">
      <button class="danger-btn" type="button" id="delete-tenant-btn" onclick="deleteTenantWithConfirm()">移除订阅地址记录</button>
      <p style="font-size:12px;color:#e00;margin-top:8px;">⚠️ 警告：将删除本订阅地址对应的全部租户数据（含所有分组与优选链接），无法恢复。</p>
    </div>

    <div class="section">
      <div class="section-title">原始订阅/节点地址</div>
      <div class="url-box">
        <input type="text" class="url-input" id="origin-sub-url" value="${escAttr(originSubscriptionUrl)}" readonly />
        <button class="copy-btn" onclick="copyUrl('origin-sub-url')">复制</button>
      </div>
      <p style="font-size:13px;color:#888;margin-top:8px;">这是当前 tenant 绑定的源地址，可以是 https 订阅链接或 vless:// 单节点链接，用于定位和生成节点模板</p>
    </div>

    <div class="section">
      <div class="section-title">优选订阅链接</div>
      <div class="url-box">
        <input type="text" class="url-input" id="sub-url" value="${escAttr(subscriptionUrl)}" readonly />
        <button class="copy-btn" onclick="copyUrl('sub-url')">复制</button>
      </div>
      <p style="font-size:13px;color:#888;margin-top:8px;">将此链接导入代理客户端（如 Hiddify）即可使用优选 IP</p>
    </div>

    <div class="section">
      <div class="section-title">管理链接</div>
      <div class="url-box">
        <input type="text" class="url-input" id="dash-url" value="${escAttr(dashboardUrl)}" readonly />
        <button class="copy-btn" onclick="copyUrl('dash-url')">复制</button>
      </div>
      <p style="font-size:13px;color:#888;margin-top:8px;">保存此链接，下次可直接进入管理页面</p>
    </div>

    <div class="section">
      <div class="section-title">导入 CSV 或手动编辑</div>
      <form class="upload-form" id="upload-form">
        <div class="form-row">
          <div class="form-group">
            <label for="group-name">分组名</label>
            <input type="text" id="group-name" placeholder="例如: home, office" required />
          </div>
          <div class="form-group">
            <label for="csv-file">CSV 文件</label>
            <input type="file" id="csv-file" accept=".csv" />
          </div>
          <button type="submit" class="upload-btn" id="upload-btn">导入 CSV</button>
          <button type="button" class="secondary-btn" id="manual-btn" onclick="startManualEdit()">手动开始</button>
        </div>
      </form>
      <div id="upload-message"></div>
    </div>

    <div class="section hidden" id="edit-section">
      <div class="edit-header">
        <div>
          <div class="section-title">编辑分组条目</div>
          <div class="table-hint">CSV 导入后可修改名字，也可手动新增、删除条目。保存后订阅会按“分组前缀-名字或 IP”生成节点名。</div>
        </div>
        <div><strong id="editing-group-label"></strong></div>
      </div>
      <div class="edit-grid">
        <table class="edit-table">
          <thead>
            <tr>
              <th style="width:38%;">IP</th>
              <th style="width:38%;">名字（可选）</th>
              <th style="width:24%;">操作</th>
            </tr>
          </thead>
          <tbody id="edit-tbody"></tbody>
        </table>
      </div>
      <div class="edit-actions">
        <button class="secondary-btn" type="button" onclick="addEmptyRow()">新增条目</button>
        <button class="upload-btn" type="button" id="save-btn" onclick="saveEditedGroup()">保存分组</button>
        <button class="secondary-btn" type="button" onclick="cancelEdit()">取消</button>
      </div>
      <div id="edit-message"></div>
    </div>

    <div class="section">
      <div class="section-title">已保存分组</div>
      <div id="groups-container">
        <div class="empty">加载中...</div>
      </div>
    </div>

    <script>
      const ACCESS_TOKEN = ${JSON.stringify(accessToken)};
      const CSV_TOP_N = ${Math.max(1, Math.min(200, topN))};
      let currentEditGroup = "";
      let currentEditItems = [];

      function getErrorMessage(err) {
        if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
          return err.message;
        }
        return String(err || "未知错误");
      }

      function copyUrl(id) {
        const input = document.getElementById(id);
        navigator.clipboard.writeText(input.value);
        const btn = input.nextElementSibling;
        btn.textContent = "已复制";
        setTimeout(() => {
          btn.textContent = "复制";
        }, 1500);
      }

      function parseNumber(val) {
        const n = Number(val);
        return Number.isFinite(n) ? n : undefined;
      }

      function parseCsv(text) {
        const lines = text.split(/\\r?\\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length <= 1) return [];
        const coloCounters = {};
        const fallbackCounters = {};
        return lines.slice(1).map((line) => {
          const [ip, , , loss, latency, speed, colo] = line.split(",");
          const coloCode = (colo || "").trim().toUpperCase();
          const lat = parseNumber(latency);
          const spd = parseNumber(speed);
          let name = "";
          if (coloCode) {
            coloCounters[coloCode] = (coloCounters[coloCode] || 0) + 1;
            name = coloCode + "-" + String(coloCounters[coloCode]).padStart(2, "0");
          } else {
            const parts = [];
            if (Number.isFinite(lat)) parts.push(Math.round(lat) + "ms");
            if (Number.isFinite(spd) && spd > 0) parts.push(Math.round(spd) + "MB");
            const base = parts.length > 0 ? parts.join("-") : "IP";
            fallbackCounters[base] = (fallbackCounters[base] || 0) + 1;
            name = base + "-" + String(fallbackCounters[base]).padStart(2, "0");
          }
          return {
            ip: (ip || "").trim(),
            name: name,
            loss: parseNumber(loss),
            latency: lat,
            speed: spd,
            colo: coloCode || undefined,
          };
        }).filter((r) => r.ip);
      }

      function pickTop(results, n) {
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

      function escapeHtml(value) {
        return String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function showMessage(targetId, type, message) {
        const el = document.getElementById(targetId);
        el.innerHTML = '<div class="message ' + type + '">' + escapeHtml(message) + '</div>';
      }

      function clearMessage(targetId) {
        document.getElementById(targetId).innerHTML = "";
      }

      function renderEditTable() {
        const tbody = document.getElementById("edit-tbody");
        if (currentEditItems.length === 0) {
          tbody.innerHTML = '<tr><td colspan="3" class="empty">暂无条目，请新增至少一个 IP</td></tr>';
          return;
        }

        tbody.innerHTML = currentEditItems.map((item, index) => {
          const ip = escapeHtml(item.ip || "");
          const name = escapeHtml(item.name || "");
          return '<tr>' +
            '<td><input class="table-input" data-field="ip" data-index="' + index + '" value="' + ip + '" placeholder="104.16.1.1" /></td>' +
            '<td><input class="table-input" data-field="name" data-index="' + index + '" value="' + name + '" placeholder="不填则默认使用 IP" /></td>' +
            '<td><button class="danger-btn" type="button" onclick="removeRow(' + index + ')">删除</button></td>' +
          '</tr>';
        }).join("");
      }

      function openEditor(groupName, items) {
        currentEditGroup = groupName;
        currentEditItems = items.map((item) => ({ ...item }));
        document.getElementById("editing-group-label").textContent = "分组：" + groupName;
        document.getElementById("edit-section").classList.remove("hidden");
        clearMessage("edit-message");
        renderEditTable();
        document.getElementById("edit-section").scrollIntoView({ behavior: "smooth", block: "start" });
      }

      function syncItemsFromInputs() {
        const next = currentEditItems.map((item) => ({ ...item }));
        document.querySelectorAll("#edit-tbody input[data-field]").forEach((input) => {
          const index = Number(input.dataset.index);
          const field = input.dataset.field;
          if (!Number.isInteger(index) || !next[index] || !field) return;
          next[index][field] = input.value.trim();
        });
        currentEditItems = next;
      }

      function addEmptyRow() {
        syncItemsFromInputs();
        currentEditItems.push({ ip: "", name: "" });
        renderEditTable();
      }

      function removeRow(index) {
        syncItemsFromInputs();
        currentEditItems.splice(index, 1);
        renderEditTable();
      }

      function cancelEdit() {
        currentEditGroup = "";
        currentEditItems = [];
        document.getElementById("edit-section").classList.add("hidden");
        clearMessage("edit-message");
      }

      function startManualEdit() {
        clearMessage("upload-message");
        const groupName = document.getElementById("group-name").value.trim();
        if (!groupName) {
          showMessage("upload-message", "error", "请输入分组名");
          return;
        }
        openEditor(groupName, [{ ip: "", name: "" }]);
      }

      async function loadGroupForEdit(groupName) {
        clearMessage("upload-message");
        try {
          const resp = await fetch("/api/group?group=" + encodeURIComponent(groupName), {
            headers: { Authorization: "Bearer " + ACCESS_TOKEN },
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || "加载分组失败");
          openEditor(data.report.ssid, data.report.results || []);
        } catch (err) {
          showMessage("upload-message", "error", getErrorMessage(err));
        }
      }

      async function saveEditedGroup() {
        syncItemsFromInputs();
        const saveBtn = document.getElementById("save-btn");
        saveBtn.disabled = true;
        saveBtn.textContent = "保存中...";
        clearMessage("edit-message");

        try {
          if (!currentEditGroup) throw new Error("缺少分组名");
          const cleaned = currentEditItems
            .map((item) => ({
              ...item,
              ip: (item.ip || "").trim(),
              name: (item.name || "").trim(),
            }))
            .filter((item) => item.ip);

          if (cleaned.length === 0) {
            throw new Error("请至少保留一个有效 IP");
          }

          const payload = {
            ssid: currentEditGroup,
            updatedAt: new Date().toISOString(),
            results: cleaned.map((item) => {
              const next = { ip: item.ip };
              if (item.name) next.name = item.name;
              if (item.latency !== undefined) next.latency = item.latency;
              if (item.loss !== undefined) next.loss = item.loss;
              if (item.speed !== undefined) next.speed = item.speed;
              if (item.colo) next.colo = item.colo;
              return next;
            }),
          };

          const resp = await fetch("/api/report", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + ACCESS_TOKEN,
            },
            body: JSON.stringify(payload),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || "保存失败");

          showMessage("edit-message", "success", "保存成功，已保存 " + data.count + " 个 IP");
          document.getElementById("group-name").value = currentEditGroup;
          loadGroups();
        } catch (err) {
          showMessage("edit-message", "error", getErrorMessage(err));
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = "保存分组";
        }
      }

      function handleGroupsContainerClick(event) {
        if (event.target.classList.contains("js-edit-group")) {
          const groupName = event.target.dataset.group || "";
          if (!groupName) return;
          loadGroupForEdit(groupName);
          return;
        }
        if (event.target.classList.contains("js-delete-group")) {
          const groupName = event.target.dataset.group || "";
          if (!groupName) return;
          deleteGroupWithConfirm(groupName);
          return;
        }
      }

      async function deleteGroupWithConfirm(groupName) {
        if (!confirm('确定要删除分组 "' + groupName + '" 吗？此操作不可撤销。')) {
          return;
        }
        try {
          const resp = await fetch("/api/group?group=" + encodeURIComponent(groupName), {
            method: "DELETE",
            headers: { Authorization: "Bearer " + ACCESS_TOKEN },
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || "删除失败");
          showMessage("upload-message", "success", "分组已删除");
          loadGroups();
        } catch (err) {
          showMessage("upload-message", "error", getErrorMessage(err));
        }
      }

      async function loadGroups() {
        const container = document.getElementById("groups-container");
        try {
          const resp = await fetch("/api/groups", {
            headers: { Authorization: "Bearer " + ACCESS_TOKEN },
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || "加载失败");

          if (!data.groups || data.groups.length === 0) {
            container.innerHTML = '<div class="empty">暂无分组，请导入 CSV 或手动新增条目</div>';
            return;
          }

          container.innerHTML = '<div class="groups-list">' + data.groups.map((g) => {
            const groupLabel = escapeHtml(g.alias || g.group);
            const rawGroup = escapeHtml(g.group);
            const topColo = escapeHtml(g.topColo || "-");
            const editButton = '<button class="group-btn js-edit-group" type="button" data-group="' + rawGroup + '">编辑</button>';
            const deleteButton = '<button class="danger-btn js-delete-group" type="button" data-group="' + rawGroup + '">删除</button>';
            return '<div class="group-item">' +
              '<div>' +
                '<div><span class="group-name">' + groupLabel + '</span>' +
                (g.alias ? ' <span style="color:#888">(' + rawGroup + ')</span>' : '') +
                '</div>' +
                '<div class="group-meta">' + g.count + ' 个 IP · ' + topColo + ' · ' + formatTime(g.updatedAt) + '</div>' +
              '</div>' +
              '<div style="display:flex;gap:8px;">' + editButton + deleteButton + '</div>' +
            '</div>';
          }).join("") + '</div>';
        } catch (err) {
          container.innerHTML = '<div class="empty" style="color:#e00;">加载失败: ' + escapeHtml(getErrorMessage(err)) + '</div>';
        }
      }

      document.getElementById("upload-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = document.getElementById("upload-btn");
        btn.disabled = true;
        btn.textContent = "导入中...";
        clearMessage("upload-message");

        try {
          const groupName = document.getElementById("group-name").value.trim();
          const fileInput = document.getElementById("csv-file");
          const file = fileInput.files[0];

          if (!groupName) throw new Error("请输入分组名");
          if (!file) throw new Error("请选择 CSV 文件");

          const text = await file.text();
          const results = parseCsv(text);
          if (results.length === 0) throw new Error("CSV 中没有有效数据");

          openEditor(groupName, pickTop(results, CSV_TOP_N));
          showMessage("upload-message", "success", "CSV 已解析，请确认后点击“保存分组”");
          fileInput.value = "";
        } catch (err) {
          showMessage("upload-message", "error", getErrorMessage(err));
        } finally {
          btn.disabled = false;
          btn.textContent = "导入 CSV";
        }
      });

      document.getElementById("groups-container").addEventListener("click", handleGroupsContainerClick);

      async function deleteTenantWithConfirm() {
        if (!confirm("确定要移除本订阅地址的全部记录吗？将删除所有分组与配置，无法恢复。\\n\\n请再次确认。")) {
          return;
        }
        if (!confirm("最后确认：移除该订阅地址记录？")) {
          return;
        }
        try {
          const resp = await fetch("/api/tenant", {
            method: "DELETE",
            headers: { Authorization: "Bearer " + ACCESS_TOKEN },
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || "删除失败");
          alert("订阅地址记录已移除，将返回首页");
          window.location.href = "/";
        } catch (err) {
          alert("删除失败: " + getErrorMessage(err));
        }
      }

      window.addEmptyRow = addEmptyRow;
      window.removeRow = removeRow;
      window.cancelEdit = cancelEdit;
      window.saveEditedGroup = saveEditedGroup;
      window.loadGroupForEdit = loadGroupForEdit;
      window.startManualEdit = startManualEdit;
      window.deleteTenantWithConfirm = deleteTenantWithConfirm;

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
  return html(dashboardPage(origin, tenantId, token, tenant.originSubscriptionUrl, tenant.topN ?? 5));
}

async function deleteTenant(request: Request, env: Env): Promise<Response> {
  const token = parseBearerToken(request);
  const tenantId = extractTenantIdFromToken(token);
  const tenant = await requireTenant(env, tenantId);

  if (tenant.accessToken !== token) {
    return errorResponse(401, "访问令牌无效");
  }

  const reports = await loadReports(env, tenantId);
  await Promise.all(
    reports.map((r) => env.REPORTS.delete(getReportKey(tenantId, r.ssid)))
  );

  await Promise.all([
    env.TENANTS.delete(getTenantKey(tenantId)),
    env.TENANTS.delete(getOriginHashKey(tenant.originUrlHash)),
  ]);

  return json({ ok: true, tenantId });
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

      if (request.method === "GET" && url.pathname === "/api/group") {
        return await getGroupReport(request, env);
      }

      if (request.method === "DELETE" && url.pathname === "/api/group") {
        return await deleteGroup(request, env);
      }

      if (request.method === "DELETE" && url.pathname === "/api/tenant") {
        return await deleteTenant(request, env);
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
