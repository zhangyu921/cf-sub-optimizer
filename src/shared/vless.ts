import { Buffer } from "node:buffer";

import type { OriginNodeTemplate, SsidReport } from "./types.js";

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function toUrlSafeName(name: string): string {
  return encodeURIComponent(name);
}

export function parseVlessUrl(rawUrl: string): OriginNodeTemplate {
  const parsed = new URL(rawUrl.trim());

  ensure(parsed.protocol === "vless:", "Only vless URLs are supported");
  ensure(parsed.username, "Missing UUID in vless URL");

  const security = parsed.searchParams.get("security");
  const transport = parsed.searchParams.get("type");
  const host = parsed.searchParams.get("host");
  const path = parsed.searchParams.get("path");
  const encryption = parsed.searchParams.get("encryption") ?? "none";
  const sni = parsed.searchParams.get("sni") ?? host;

  ensure(security === "tls", "Only tls security is supported");
  ensure(transport === "ws", "Only ws transport is supported");
  ensure(host, "Missing host param in vless URL");
  ensure(path, "Missing path param in vless URL");
  ensure(sni, "Missing sni/host value in vless URL");
  ensure(encryption === "none", "Only encryption=none is supported");

  return {
    protocol: "vless",
    uuid: parsed.username,
    server: parsed.hostname,
    port: Number(parsed.port || 443),
    security: "tls",
    transport: "ws",
    host,
    sni,
    path,
    encryption: "none",
    name: parsed.hash ? decodeURIComponent(parsed.hash.slice(1)) : undefined,
  };
}

export function extractFirstVlessTemplate(subscriptionText: string): OriginNodeTemplate {
  const trimmed = subscriptionText.trim();
  const candidates = trimmed.startsWith("vless://")
    ? trimmed.split(/\r?\n/).filter(Boolean)
    : Buffer.from(trimmed, "base64")
        .toString("utf8")
        .split(/\r?\n/)
        .filter(Boolean);

  const firstVless = candidates.find((line) => line.startsWith("vless://"));
  ensure(firstVless, "No vless URL found in subscription");

  return parseVlessUrl(firstVless);
}

export function buildVlessUrl(template: OriginNodeTemplate, server: string, name: string): string {
  const url = new URL(`vless://${template.uuid}@${server}:${template.port}`);

  url.searchParams.set("encryption", template.encryption);
  url.searchParams.set("host", template.host);
  url.searchParams.set("path", template.path);
  url.searchParams.set("security", template.security);
  url.searchParams.set("type", template.transport);
  url.searchParams.set("sni", template.sni);
  url.hash = toUrlSafeName(name);

  return url.toString();
}

export function buildNodeName(report: SsidReport, itemName?: string): string {
  const label = report.alias?.trim() || report.ssid.trim();
  const displayName = itemName?.trim() || "IP";

  return `${label}-${displayName}`;
}

/** 与原始订阅相同的入口（template.server）；名称以 `!` 开头，在多数客户端「按名称」字典序排序时排在字母/数字节点之前 */
export const ORIGIN_NODE_DISPLAY_NAME = "!Origin";

export function buildSubscriptionLines(
  template: OriginNodeTemplate,
  reports: SsidReport[],
): string[] {
  const lines: string[] = [buildVlessUrl(template, template.server, ORIGIN_NODE_DISPLAY_NAME)];

  for (const report of reports) {
    report.results.forEach((result) => {
      const itemName = result.name?.trim() || result.ip;
      const name = buildNodeName(report, itemName);
      lines.push(buildVlessUrl(template, result.ip, name));
    });
  }

  return lines;
}

export function encodeSubscription(lines: string[]): string {
  return Buffer.from(lines.join("\n"), "utf8").toString("base64");
}
