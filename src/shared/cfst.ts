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

export function parseCfstCsv(csvText: string): SpeedTestResult[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return [];
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

    let name: string;
    if (coloCode) {
      const region = coloRegionZh(coloCode);
      const lineZh = lineCode ? hostmonitLineLabel(lineCode) : "";
      const base = lineZh ? `${region}(${coloCode})·${lineZh}` : `${region}(${coloCode})`;
      baseCounters[base] = (baseCounters[base] || 0) + 1;
      name = `${base}-${String(baseCounters[base]).padStart(2, "0")}`;
    } else {
      const hintParts: string[] = [];
      if (latency !== undefined) hintParts.push(`${Math.round(latency)}ms`);
      if (speed !== undefined && speed > 0) hintParts.push(`${Math.round(speed)}MB`);
      const base = hintParts.length > 0 ? hintParts.join("-") : "IP";
      fallbackCounters[base] = (fallbackCounters[base] || 0) + 1;
      name = `${base}-${String(fallbackCounters[base]).padStart(2, "0")}`;
    }

    return {
      ip,
      name,
      loss: parseNumber(lossRaw),
      latency,
      speed,
      colo: coloCode || undefined,
    };
  })
    .filter((r) => r.ip);
}

export function pickTopResults(results: SpeedTestResult[], topN: number): SpeedTestResult[] {
  return results.slice(0, Math.max(0, topN));
}
