import { argv, exit } from "node:process";

import {
  loadAgentConfig,
  previewReport,
  previewReportFromCsv,
  runOnceFromCsv,
  runOnceWithOverride,
} from "./index.js";

function getArgValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

function getConfigPath(): string {
  return getArgValue("--config") ?? "agent.config.json";
}

function getGroupOverride(): string | undefined {
  return getArgValue("--group");
}

function getCsvPath(): string | undefined {
  return getArgValue("--csv");
}

async function main(): Promise<void> {
  const command = argv[2];

  if (!command || ["run-once", "preview"].includes(command) === false) {
    throw new Error(
      "Usage: agent <run-once|preview> [--config agent.config.json] [--group home] [--csv result.csv]",
    );
  }

  const config = await loadAgentConfig(getConfigPath());
  const groupOverride = getGroupOverride();
  const csvPath = getCsvPath();

  if (command === "preview") {
    const report = csvPath
      ? await previewReportFromCsv(config, { csvPath, groupOverride })
      : await previewReport(config, groupOverride);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const result = csvPath
    ? await runOnceFromCsv(config, { csvPath, groupOverride })
    : await runOnceWithOverride(config, groupOverride);

  const output: Record<string, unknown> = {
    group: result.report.ssid,
    alias: result.report.alias,
    count: result.report.results.length,
    uploadResult: result.uploadResult,
  };

  if (config.proxySubscriptionUrl) {
    output.subscriptionUrl = config.proxySubscriptionUrl;
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(message);
  exit(1);
});
