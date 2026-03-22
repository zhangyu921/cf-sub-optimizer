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

  const coloCounters: Record<string, number> = {};
  const fallbackCounters: Record<string, number> = {};

  return lines
    .slice(1)
    .map((line) => {
    const [ipRaw, , , lossRaw, latencyRaw, speedRaw, coloRaw] = line.split(",");
    const ip = (ipRaw || "").trim();
    const coloCode = (coloRaw || "").trim().toUpperCase();
    const latency = parseOptionalNumber(latencyRaw);
    const speed = parseOptionalNumber(speedRaw);

    let name: string;
    if (coloCode) {
      coloCounters[coloCode] = (coloCounters[coloCode] || 0) + 1;
      name = `${coloCode}-${String(coloCounters[coloCode]).padStart(2, "0")}`;
    } else {
      const parts: string[] = [];
      if (latency !== undefined) parts.push(`${Math.round(latency)}ms`);
      if (speed !== undefined && speed > 0) parts.push(`${Math.round(speed)}MB`);
      const base = parts.length > 0 ? parts.join("-") : "IP";
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
