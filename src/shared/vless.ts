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

export function buildNodeName(report: SsidReport, rank: number, latency: number, colo?: string): string {
  const label = report.alias?.trim() || report.ssid.trim();
  const rankString = String(rank).padStart(2, "0");
  const coloLabel = colo?.trim() || "UNK";
  const latencyLabel = Number.isFinite(latency) ? `${Math.round(latency)}ms` : "NA";

  return `${label}-${rankString}-${coloLabel}-${latencyLabel}`;
}

export function buildSubscriptionLines(
  template: OriginNodeTemplate,
  reports: SsidReport[],
): string[] {
  const lines: string[] = [];

  for (const report of reports) {
    report.results.forEach((result, index) => {
      const name = buildNodeName(report, index + 1, result.latency, result.colo);
      lines.push(buildVlessUrl(template, result.ip, name));
    });
  }

  return lines;
}

export function encodeSubscription(lines: string[]): string {
  return Buffer.from(lines.join("\n"), "utf8").toString("base64");
}
