import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import { parseCfstCsv, pickTopResults } from "../shared/cfst.js";
import type { ReportPayload } from "../shared/types.js";

export interface AgentConfig {
  workerBaseUrl: string;
  uploadToken: string;
  topN: number;
  defaultGroup?: string;
  proxySubscriptionUrl?: string;
  passthroughCfstOutput?: boolean;
  aliases?: Record<string, string>;
  cfst: {
    binaryPath: string;
    workingDirectory?: string;
    args?: string[];
  };
}

export interface LoadedAgentConfig extends AgentConfig {
  configPath: string;
  configDirectory: string;
}

function resolvePathLike(value: string | undefined, configDirectory: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return isAbsolute(value) ? value : resolve(configDirectory, value);
}

function normalizeBaseUrl(workerBaseUrl: string): string {
  return workerBaseUrl.replace(/\/+$/, "");
}

function getAlias(group: string, aliases?: Record<string, string>): string | undefined {
  return aliases?.[group]?.trim() || undefined;
}

export interface RunFromCsvOptions {
  csvPath: string;
  groupOverride?: string;
}

export interface RunResult {
  report: ReportPayload;
  uploadResult: unknown;
}

function resolveGroup(config: LoadedAgentConfig, groupOverride?: string): string {
  const group = groupOverride?.trim() || config.defaultGroup?.trim();
  if (group) {
    return group;
  }

  throw new Error("Missing group. Pass --group or set defaultGroup in agent.config.json");
}

export async function loadAgentConfig(configPath: string): Promise<LoadedAgentConfig> {
  const absoluteConfigPath = resolve(configPath);
  const configDirectory = dirname(absoluteConfigPath);
  const configText = await readFile(absoluteConfigPath, "utf8");
  const parsed = JSON.parse(configText) as AgentConfig;

  if (!parsed.workerBaseUrl) {
    throw new Error("Missing workerBaseUrl in agent config");
  }

  if (!parsed.uploadToken) {
    throw new Error("Missing uploadToken in agent config");
  }

  if (!parsed.cfst?.binaryPath) {
    throw new Error("Missing cfst.binaryPath in agent config");
  }

  return {
    ...parsed,
    workerBaseUrl: normalizeBaseUrl(parsed.workerBaseUrl),
    topN: parsed.topN ?? 5,
    defaultGroup: parsed.defaultGroup?.trim() || undefined,
    configPath: absoluteConfigPath,
    configDirectory,
    cfst: {
      binaryPath: resolve(configDirectory, parsed.cfst.binaryPath),
      workingDirectory: resolvePathLike(parsed.cfst.workingDirectory, configDirectory),
      args: parsed.cfst.args ?? [],
    },
  };
}

export async function buildReportFromCsv(
  csvPath: string,
  ssid: string,
  alias: string | undefined,
  config: Pick<AgentConfig, "topN">,
): Promise<ReportPayload> {
  const csvText = await readFile(csvPath, "utf8");
  const allResults = parseCfstCsv(csvText);

  if (allResults.length === 0) {
    throw new Error(`No valid results found in CSV: ${csvPath}`);
  }

  const results = pickTopResults(allResults, config.topN);

  return {
    ssid,
    alias,
    updatedAt: new Date().toISOString(),
    results,
  };
}

export async function runCfst(config: LoadedAgentConfig): Promise<string> {
  const tempDirectory = await mkdtemp(resolve(tmpdir(), "cf-ip-choose-"));
  const outputCsvPath = resolve(tempDirectory, "result.csv");
  const args = [...(config.cfst.args ?? []), "-o", outputCsvPath, "-p", "0"];
  const passthroughOutput = config.passthroughCfstOutput ?? true;

  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(config.cfst.binaryPath, args, {
        cwd: config.cfst.workingDirectory,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer | string) => {
        if (passthroughOutput) {
          process.stdout.write(chunk);
        }
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        if (passthroughOutput) {
          process.stderr.write(chunk);
        }
      });

      child.on("error", (error) => {
        rejectPromise(error);
      });

      child.on("close", (code, signal) => {
        if (signal) {
          rejectPromise(new Error(`CFST terminated by signal: ${signal}`));
          return;
        }

        if (code !== 0) {
          rejectPromise(new Error(`CFST exited with code ${code ?? "unknown"}`));
          return;
        }

        resolvePromise();
      });
    });

    return outputCsvPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CFST execution error";
    throw new Error(`CFST execution failed: ${message}`);
  }
}

export async function uploadReport(
  config: Pick<AgentConfig, "workerBaseUrl" | "uploadToken">,
  report: ReportPayload,
): Promise<unknown> {
  const response = await fetch(`${config.workerBaseUrl}/api/report`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.uploadToken}`,
    },
    body: JSON.stringify(report),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const reason = payload?.error || text || `HTTP ${response.status}`;
    throw new Error(`Upload failed: ${reason}`);
  }

  return payload;
}

export async function previewReport(
  config: LoadedAgentConfig,
  groupOverride?: string,
): Promise<ReportPayload> {
  const ssid = resolveGroup(config, groupOverride);
  const alias = getAlias(ssid, config.aliases);
  const csvPath = await runCfst(config);

  try {
    return await buildReportFromCsv(csvPath, ssid, alias, config);
  } finally {
    await rm(dirname(csvPath), { recursive: true, force: true });
  }
}

export async function runOnceWithOverride(
  config: LoadedAgentConfig,
  groupOverride?: string,
): Promise<RunResult> {
  const report = await previewReport(config, groupOverride);
  const uploadResult = await uploadReport(config, report);

  return { report, uploadResult };
}

export async function previewReportFromCsv(
  config: LoadedAgentConfig,
  options: RunFromCsvOptions,
): Promise<ReportPayload> {
  const group = resolveGroup(config, options.groupOverride);
  const alias = getAlias(group, config.aliases);
  const csvPath = resolveCsvPath(options.csvPath, config.configDirectory);

  try {
    await access(csvPath);
  } catch {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  return buildReportFromCsv(csvPath, group, alias, config);
}

export async function runOnceFromCsv(
  config: LoadedAgentConfig,
  options: RunFromCsvOptions,
): Promise<RunResult> {
  const report = await previewReportFromCsv(config, options);
  const uploadResult = await uploadReport(config, report);

  return { report, uploadResult };
}

function resolveCsvPath(csvPath: string, configDirectory: string): string {
  return isAbsolute(csvPath) ? csvPath : resolve(configDirectory, csvPath);
}
