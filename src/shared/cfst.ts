import { coloRegionZh, hostmonitLineLabel } from "./hostmonit.js";
import type { SpeedTestResult } from "./types.js";

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  const t = value?.trim();
  if (t === undefined || t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function stripBom(line: string): string {
  return line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
}

function normalizeHeaderCell(h: string): string {
  return stripBom(h).trim().toLowerCase();
}

/** 带表头的新版导出（mcis 等）：含 download_mbps，或 rank+score_ms / rank+prefix 等 */
function looksLikeNamedHeaderRow(headerCells: string[]): boolean {
  const h = headerCells.map(normalizeHeaderCell);
  const set = new Set(h);
  if (!set.has("ip")) return false;
  if (set.has("download_mbps")) return true;
  if (set.has("rank") && set.has("score_ms")) return true;
  if (set.has("rank") && set.has("prefix")) return true;
  return false;
}

function headerRowHasIpColumn(headerCells: string[]): boolean {
  return headerCells.map(normalizeHeaderCell).includes("ip");
}

/** 首列为 rank、第二列为 IPv4/IPv6 时，绝不能走固定列解析（否则会把 rank 当 ip） */
function secondRowLooksLikeRankThenIp(lines: string[]): boolean {
  if (lines.length < 2) return false;
  const parts = lines[1].split(",");
  if (parts.length < 2) return false;
  const a = (parts[0] ?? "").trim();
  const b = (parts[1] ?? "").trim();
  if (!/^\d+$/.test(a)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(b)) return true;
  if (b.includes(":") && b.length >= 3) return true;
  return false;
}

function shouldParseNamedCsv(lines: string[]): boolean {
  const firstRowCells = lines[0].split(",").map((c) => c.trim());
  if (looksLikeNamedHeaderRow(firstRowCells)) return true;
  if (headerRowHasIpColumn(firstRowCells) && secondRowLooksLikeRankThenIp(lines)) return true;
  return false;
}

function cell(parts: string[], index: number): string {
  return (parts[index] ?? "").trim();
}

function buildName(
  coloCode: string,
  lineCode: string,
  speed: number | undefined,
  baseCounters: Record<string, number>,
  fallbackCounters: Record<string, number>,
): string {
  if (coloCode) {
    const region = coloRegionZh(coloCode);
    const lineZh = lineCode ? hostmonitLineLabel(lineCode) : "";
    const base = lineZh ? `${region}(${coloCode})·${lineZh}` : `${region}(${coloCode})`;
    baseCounters[base] = (baseCounters[base] ?? 0) + 1;
    return `${base}-${String(baseCounters[base]).padStart(2, "0")}`;
  }
  const hintParts: string[] = [];
  if (speed !== undefined && speed > 0) hintParts.push(`${Math.round(speed)}MB`);
  const base = hintParts.length > 0 ? hintParts.join("-") : "IP";
  fallbackCounters[base] = (fallbackCounters[base] ?? 0) + 1;
  return `${base}-${String(fallbackCounters[base]).padStart(2, "0")}`;
}

/** 固定列：第 1 行为表头（任意），从第 2 行起为数据；列为 ip,,,loss,speed?,colo,line（与 Hostmonit/旧 CFST 一致） */
function parseLegacyFixedRows(lines: string[]): SpeedTestResult[] {
  const headerCells = lines[0].split(",").map((c) => c.trim());
  if (headerRowHasIpColumn(headerCells) && secondRowLooksLikeRankThenIp(lines)) {
    return parseNamedHeaderRows(lines);
  }

  const baseCounters: Record<string, number> = {};
  const fallbackCounters: Record<string, number> = {};

  return lines
    .slice(1)
    .map((line) => {
      const parts = line.split(",");
      const [ipRaw, , , lossRaw, latencyRaw, speedRaw, coloRaw, lineRaw] = parts;
      const ip = (ipRaw || "").trim();
      const coloCode = (coloRaw || "").trim().toUpperCase();
      const lineCode = (lineRaw || "").trim();
      const latency = parseOptionalNumber(latencyRaw);
      const speed = parseOptionalNumber(speedRaw);
      const name = buildName(coloCode, lineCode, speed, baseCounters, fallbackCounters);

      return {
        ip,
        name,
        loss: parseNumber(lossRaw ?? "0"),
        latency,
        speed,
        colo: coloCode || undefined,
      };
    })
    .filter((r) => r.ip);
}

/** 第 1 行为列名，按列名取 ip/colo/download_mbps/line/score_ms 等 */
function parseNamedHeaderRows(lines: string[]): SpeedTestResult[] {
  const headerCells = lines[0].split(",").map((c) => c.trim());
  const headers = headerCells.map(normalizeHeaderCell);
  const idx = (name: string): number => headers.indexOf(name);

  const ipI = idx("ip");
  if (ipI < 0) return [];

  const coloI = idx("colo");
  const speedI = idx("download_mbps");
  const legacySpeedI = idx("speed");
  const lossI = idx("loss");
  const lineI = idx("line");
  const scoreI = idx("score_ms");
  const totalI = idx("total_ms");
  const latencyI = idx("latency");

  const baseCounters: Record<string, number> = {};
  const fallbackCounters: Record<string, number> = {};

  return lines
    .slice(1)
    .map((line) => {
      const parts = line.split(",");
      const ip = cell(parts, ipI);
      const coloCode = coloI >= 0 ? cell(parts, coloI).toUpperCase() : "";
      const lineCode = lineI >= 0 ? cell(parts, lineI) : "";

      let speed: number | undefined;
      if (speedI >= 0) speed = parseOptionalNumber(cell(parts, speedI));
      if (speed === undefined && legacySpeedI >= 0) speed = parseOptionalNumber(cell(parts, legacySpeedI));

      let latency: number | undefined;
      if (latencyI >= 0) latency = parseOptionalNumber(cell(parts, latencyI));
      if (latency === undefined && scoreI >= 0) latency = parseOptionalNumber(cell(parts, scoreI));
      if (latency === undefined && totalI >= 0) latency = parseOptionalNumber(cell(parts, totalI));

      let loss = 0;
      if (lossI >= 0) loss = parseNumber(cell(parts, lossI));

      const name = buildName(coloCode, lineCode, speed, baseCounters, fallbackCounters);

      return {
        ip,
        name,
        loss,
        latency,
        speed,
        colo: coloCode || undefined,
      };
    })
    .filter((r) => r.ip);
}

/**
 * 支持两种 CSV：
 * 1. 固定列（旧）：首行任意表头，数据列为 ip,,,loss,latency,speed,colo,line（第 8 列可选 CM/CU/CT）
 * 2. 表头映射（新）：首行为列名，须含 ip；含 download_mbps 或 rank+score_ms 等时按列名解析
 * 节点名：有 colo 时为「地区名(colo)·线路-序号」；无 colo 时用速度(MB) 生成短名（不再用延迟）
 */
export function parseCfstCsv(csvText: string): SpeedTestResult[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return [];
  }

  if (shouldParseNamedCsv(lines)) {
    return parseNamedHeaderRows(lines);
  }
  return parseLegacyFixedRows(lines);
}

export function pickTopResults(results: SpeedTestResult[], topN: number): SpeedTestResult[] {
  return results.slice(0, Math.max(0, topN));
}
