/**
 * Hostmonit get_optimization_ip 响应解析与节点展示名（含地理位置/机房/线路）。
 * 文档与稳定性依赖第三方，解析失败时返回空数组。
 */

export interface HostmonitOptimizedEntry {
  ip: string;
  name: string;
}

/** Cloudflare colo 代码 → 常用中文地理/城市描述（未知则回退为代码本身） */
export const CF_COLO_REGION_ZH: Record<string, string> = {
  AMS: "阿姆斯特丹",
  ARN: "斯德哥尔摩",
  ATL: "亚特兰大",
  BOM: "孟买",
  BOS: "波士顿",
  CDG: "巴黎",
  DEN: "丹佛",
  DFW: "达拉斯",
  DME: "莫斯科",
  DXB: "迪拜",
  EWR: "纽瓦克",
  FRA: "法兰克福",
  GRU: "圣保罗",
  HAM: "汉堡",
  HKG: "香港",
  IAD: "阿什本",
  ICN: "首尔",
  JNB: "约翰内斯堡",
  KBP: "基辅",
  KIX: "大阪",
  LAS: "拉斯维加斯",
  LAX: "洛杉矶",
  LHR: "伦敦",
  MAD: "马德里",
  MEL: "墨尔本",
  MEX: "墨西哥城",
  MIA: "迈阿密",
  MSP: "明尼阿波利斯",
  MRS: "马赛",
  NRT: "东京",
  ORD: "芝加哥",
  OTP: "布加勒斯特",
  PDX: "波特兰",
  PER: "珀斯",
  PHX: "菲尼克斯",
  QRO: "克雷塔罗",
  RIX: "里加",
  SEA: "西雅图",
  SIN: "新加坡",
  SJC: "圣何塞",
  SOF: "索非亚",
  SYD: "悉尼",
  TPE: "台北",
  VIE: "维也纳",
  WAW: "华沙",
  YUL: "蒙特利尔",
  YVR: "温哥华",
  YYZ: "多伦多",
  ZRH: "苏黎世",
};

export const CF_LINE_ZH: Record<string, string> = {
  CM: "移动",
  CU: "联通",
  CT: "电信",
};

export function hostmonitLineLabel(line: string): string {
  const k = line.trim().toUpperCase();
  return CF_LINE_ZH[k] ?? line;
}

export function coloRegionZh(colo: string): string {
  const c = colo.trim().toUpperCase();
  return CF_COLO_REGION_ZH[c] ?? c;
}

/** 不含序号；同 base 多 IP 时在解析层追加 -01、-02 */
export function buildHostmonitNodeNameBase(colo: string, line: string): string {
  const region = coloRegionZh(colo);
  const coloU = colo.trim().toUpperCase();
  const lt = line.trim();
  if (!lt) {
    return `HM-${region}(${coloU})`;
  }
  return `HM-${region}(${coloU})·${hostmonitLineLabel(line)}`;
}

/** 将 API JSON 转为可生成 vless 的条目（每条 info 一行，含 CM/CU/CT 多线路） */
export function parseHostmonitOptimizationResponse(data: unknown): HostmonitOptimizedEntry[] {
  if (!data || typeof data !== "object") return [];
  const root = data as { code?: number; info?: unknown };
  if (root.code !== 200 || !Array.isArray(root.info)) return [];

  const out: HostmonitOptimizedEntry[] = [];
  const serialByBase: Record<string, number> = {};

  for (const row of root.info) {
    if (!row || typeof row !== "object") continue;
    const r = row as { ip?: unknown; colo?: unknown; line?: unknown };
    const ip = typeof r.ip === "string" ? r.ip.trim() : "";
    if (!ip) continue;
    const colo = typeof r.colo === "string" ? r.colo : "";
    const line = typeof r.line === "string" ? r.line : "";
    const base = buildHostmonitNodeNameBase(colo, line);
    serialByBase[base] = (serialByBase[base] ?? 0) + 1;
    const name = `${base}-${String(serialByBase[base]).padStart(2, "0")}`;
    out.push({ ip, name });
  }
  return out;
}
