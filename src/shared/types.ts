export interface SpeedTestResult {
  ip: string;
  name?: string;
  latency?: number;
  loss?: number;
  speed?: number;
  colo?: string;
}

export interface SsidReport {
  ssid: string;
  alias?: string;
  updatedAt: string;
  results: SpeedTestResult[];
}

export interface OriginNodeTemplate {
  protocol: "vless";
  uuid: string;
  server: string;
  port: number;
  security: "tls";
  transport: "ws";
  host: string;
  sni: string;
  path: string;
  encryption: "none";
  name?: string;
}

export interface TenantConfig {
  tenantId: string;
  originSubscriptionUrl: string;
  originNodeTemplate: OriginNodeTemplate;
  accessToken: string;
  originUrlHash: string;
  aliases: Record<string, string>;
  topN: number;
}

export interface TenantRecord extends TenantConfig {
  createdAt: string;
}

export interface CreateTenantInput {
  originSubscriptionUrl: string;
}

export interface CreateTenantOutput {
  tenantId: string;
  accessToken: string;
  dashboardUrl: string;
  subscriptionUrl: string;
}

export interface LookupInput {
  url: string;
}

export interface LookupOutput {
  tenantId: string;
  accessToken: string;
  isNew: boolean;
}

export interface GroupSummary {
  group: string;
  alias?: string;
  count: number;
  updatedAt: string;
  topColo?: string;
}

export interface ReportPayload extends SsidReport {}
