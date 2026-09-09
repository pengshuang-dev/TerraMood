// ============================================================
// Card 13-Rev v2 · 统一快照类型（Snapshot / Phenomena / freshness）
// ============================================================

/** 快照新鲜度：任一源拉取失败（保留历史值）即 stale */
export type Freshness = "fresh" | "stale";

/** 数据源追踪键（SWPC 拆为 ovation/Kp 两个独立跟踪） */
export type SourceKey =
  | "usgs"
  | "nhc"
  | "swpcOvation"
  | "swpcKp"
  | "gibs"
  | "eonet"
  | "firms";

/** USGS 地震（§2：top 50 by mag） */
export interface Quake {
  mag: number | null;
  place: string;
  /** epoch 毫秒 */
  time: number;
  lat: number;
  lon: number;
  /** 深度 km（coordinates[2]） */
  depth: number | null;
}

/** NHC 台风（§2：activeStorms；无风暴 → 空数组） */
export interface Storm {
  name: string;
  type: string;
  /** advNumber */
  adv: number | null;
}

/** SWPC 极光（ovation_aurora_latest 最大 prob + planetary-k-index 最后一行） */
export interface Aurora {
  ovationMax: number | null;
  kp: number | null;
}

/** NASA GIBS 云（不拉瓦片，客户端按需拼接） */
export interface Cloud {
  /** YYYY-MM-DD（UTC 今日） */
  date: string;
  /** 瓦片模板：{Time}/{z}/{y}/{x} 由客户端替换 */
  tileBase: string;
}

/** EONET 火山（category=volcanoes&status=open） */
export interface Volcano {
  name: string;
  lat: number;
  lon: number;
}

/** FIRMS 野火（top 100 by frp；无 FIRMS_KEY 或解析失败 → null） */
export interface Fire {
  lat: number;
  lon: number;
  /** 火辐射功率（MW） */
  frp: number | null;
  /** VIIRS bright_ti4，开尔文 */
  brightness: number | null;
}

/** 六大自然现象的统一 Schema；null = 该源从未成功落 KV（或 FIRMS 未配置） */
export interface Phenomena {
  quakes: Quake[] | null;
  storms: Storm[] | null;
  aurora: Aurora | null;
  cloud: Cloud | null;
  volcanoes: Volcano[] | null;
  fires: Fire[] | null;
}

/** 单源健康状态（降级 Ladder 的记账本） */
export interface SourceState {
  /** 最近一次成功落 KV 的时间（ISO）；null = 从未成功 */
  updatedAt: string | null;
  ok: boolean;
  error: string | null;
}

/** KV 中存储的完整快照，/v1/now 原样返回 */
export interface Snapshot {
  freshness: Freshness;
  /** 最近一次聚合时间（ISO，无论成败都会刷新） */
  updatedAt: string;
  data: Phenomena;
  sources: Record<SourceKey, SourceState>;
}
