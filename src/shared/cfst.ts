import type { SpeedTestResult } from "./types.js";

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseCfstCsv(csvText: string): SpeedTestResult[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) {
    return [];
  }

  return lines.slice(1).map((line) => {
    const [ip, , , loss, latency, speed, colo] = line.split(",");

    return {
      ip,
      loss: parseNumber(loss),
      latency: parseNumber(latency),
      speed: parseNumber(speed),
      colo: colo || undefined,
    };
  });
}

export function pickTopResults(results: SpeedTestResult[], topN: number): SpeedTestResult[] {
  return results.slice(0, Math.max(0, topN));
}
