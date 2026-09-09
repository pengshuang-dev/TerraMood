// ============================================================
// Card 13-Rev v2 · 6 大数据源 Fetcher
// 端点以任务卡 §2 为唯一真相源；§2 文字与官方实测有出入处，
// 以官方为准并逐处注释（FIRMS day_range / SWPC Kp 行格式 / GIBS tileset 下划线 / EONET v3 geometry）。
// 统一防御性约定：
//   - try/catch 包裹，超时 8s（AbortController）
//   - 字段缺失给默认值，数组截断 top N
//   - fetcher 返回 null = 本次失败 → 调用方保留 KV 历史值（降级，不抛错）
// ============================================================

import type { Aurora, Cloud, Fire, Quake, Storm, Volcano } from "./types";

const FETCH_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET JSON；非 2xx / 解析失败一律抛错，由各 fetcher catch 降级 */
async function getJson<T = unknown>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

function numOrNull(v: unknown): number | null {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && v.trim() !== ""
        ? Number(v)
        : NaN;
  return Number.isFinite(n) ? n : null;
}

function numOr0(v: unknown): number {
  return numOrNull(v) ?? 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

// ------------------------------------------------------------
// 1) USGS 地震
// §2: https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson
//     features[].properties{mag,place,time} + geometry.coordinates=[lon,lat,depth]
//     → quakes[]{mag,place,time,lat,lon,depth}，top 50 by mag
// ------------------------------------------------------------
export async function fetchUSGS(): Promise<Quake[] | null> {
  try {
    const geo = await getJson<{
      features?:
        | Array<{
            properties?: { mag?: unknown; place?: unknown; time?: unknown } | null;
            geometry?: { coordinates?: unknown } | null;
          } | null>
        | null;
    }>(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson",
    );
    const quakes: Quake[] = (geo.features ?? [])
      .map((f): Quake => {
        const p = f?.properties ?? {};
        const coords = f?.geometry?.coordinates; // 先取局部变量，规避可选链 narrow 限制
        const c = Array.isArray(coords) ? (coords as unknown[]) : [];
        return {
          mag: numOrNull(p.mag),
          place: str(p.place),
          time: typeof p.time === "number" ? p.time : 0,
          lon: numOr0(c[0]),
          lat: numOr0(c[1]),
          depth: numOrNull(c[2]),
        };
      })
      .sort((a, b) => (b.mag ?? -Infinity) - (a.mag ?? -Infinity))
      .slice(0, 50);
    return quakes;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// 2) NHC 台风
// §2: https://www.nhc.noaa.gov/CurrentStorms.json
//     activeStorms[].stormInfo{stormName,stormType,advNumber} → storms[]{name,type,adv}
//     无风暴返回空数组
// ------------------------------------------------------------
export async function fetchNHC(): Promise<Storm[] | null> {
  try {
    const data = await getJson<{
      activeStorms?:
        | Array<{
            stormInfo?: {
              stormName?: unknown;
              stormType?: unknown;
              advNumber?: unknown;
            } | null;
          } | null>
        | null;
    }>("https://www.nhc.noaa.gov/CurrentStorms.json");
    const storms: Storm[] = (data.activeStorms ?? []).map((s) => {
      const info = s?.stormInfo ?? {};
      return {
        name: str(info.stormName),
        type: str(info.stormType),
        adv: numOrNull(info.advNumber),
      };
    });
    return storms;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// 3) SWPC 极光 ovation
// §2: https://services.swpc.noaa.gov/json/ovation_aurora_latest.json
//     coordinates[]=[lon,lat,prob] → aurora{ovationMax: 最大 prob}
// ------------------------------------------------------------
export async function fetchOvation(): Promise<number | null> {
  try {
    const data = await getJson<{ coordinates?: unknown[] | null }>(
      "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json",
    );
    let max: number | null = null;
    for (const row of data.coordinates ?? []) {
      if (!Array.isArray(row)) continue;
      const prob = numOrNull(row[2]);
      if (prob !== null && (max === null || prob > max)) max = prob;
    }
    return max;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// 4) SWPC Kp
// §2: https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json
// 注：§2 原文写"JSON 数组，每行 [tag,time,...,kp]"；官方实测（2026-09 核对）
//     现为对象数组 [{"time_tag":"...","Kp":2.33,"a_running":..,"station_count":..}]。
//     以官方为准：取最后一项的 Kp；对旧行式数组 [[time_tag,Kp,...],...] 保留兜底。
// ------------------------------------------------------------
export async function fetchKp(): Promise<number | null> {
  try {
    const raw = await getJson<unknown>(
      "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
    );
    if (!Array.isArray(raw) || raw.length === 0) return null;

    // 新格式：对象数组，直接取最后一项 Kp
    const last = raw[raw.length - 1] as unknown;
    if (!Array.isArray(last)) {
      const obj = last as Record<string, unknown> | null;
      return numOrNull(obj?.Kp ?? obj?.kp);
    }

    // 旧格式兜底：行式数组，从最后一行起找第一个 0..9 的数值列（Kp 位于表头第 1 列）
    for (let i = raw.length - 1; i >= 0; i--) {
      const row = raw[i] as unknown[];
      if (!Array.isArray(row)) continue;
      for (let c = 1; c < Math.min(row.length, 4); c++) {
        const v = numOrNull(row[c]);
        if (v !== null && v >= 0 && v <= 9) return v;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// 5) NASA GIBS 云
// §2: 不拉瓦片，只返回 cloud{date, tileBase: 模板} 供客户端按需拼。
// 注：§2 模板中 TileMatrixSet 写作 "GoogleMapsCompatibleLevel9"，
//     官方 GIBS WMTS(epsg3857) 该层名为 "GoogleMapsCompatible_Level9"（带下划线），
//     以官方为准。{Time} 用 UTC 今日；当天瓦片可能尚未生成，客户端可自行回退前一日。
// ------------------------------------------------------------
export const GIBS_TILE_BASE =
  "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{Time}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg";

export function fetchGIBS(): Cloud {
  // 无网络请求，恒成功
  return { date: new Date().toISOString().slice(0, 10), tileBase: GIBS_TILE_BASE };
}

// ------------------------------------------------------------
// 6) EONET 火山
// §2: https://eonet.gsfc.nasa.gov/api/v3/events?category=volcanoes&status=open
//     events[]{id,title,geometry.coordinates=[lon,lat]} → volcanoes[]{name,lat,lon}
// 注：EONET v3 的 events[].geometry 是数组（按时间递增），官方语义取最新一条
//     （即最后一个元素）的 coordinates=[lon,lat]。
// ------------------------------------------------------------
export async function fetchEONET(): Promise<Volcano[] | null> {
  try {
    const data = await getJson<{
      events?:
        | Array<{
            title?: unknown;
            geometry?: Array<{ coordinates?: unknown } | null> | null;
          } | null>
        | null;
    }>(
      "https://eonet.gsfc.nasa.gov/api/v3/events?category=volcanoes&status=open",
    );
    const volcanoes: Volcano[] = [];
    for (const ev of data.events ?? []) {
      const geoms = ev?.geometry;
      if (!Array.isArray(geoms) || geoms.length === 0) continue;
      const g = geoms[geoms.length - 1]; // v3：取最新一条 geometry
      const coords = g?.coordinates; // 先取局部变量，规避可选链 narrow 限制
      const c = Array.isArray(coords) ? (coords as unknown[]) : [];
      if (c.length < 2) continue;
      volcanoes.push({
        name: str(ev.title),
        lat: numOr0(c[1]),
        lon: numOr0(c[0]),
      });
    }
    return volcanoes.slice(0, 100); // 防御性截断（全球 open 火山约数十个）
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// 7) FIRMS 野火 —— Patch 版（CSV 解析）
// 补丁指定端点：.../api/area/csv/{FIRMS_KEY}/VIIRS_SNPP_NRT/world/last_1day
// 官方 Area API 文档核对（2026-09，https://firms.modaps.eosdis.nasa.gov/api/area/）：
//   路径  /api/area/csv/[MAP_KEY]/[SOURCE]/[AREA_COORDINATES]/[DAY_RANGE]
//   SOURCE 含 VIIRS_SNPP_NRT ✓；AREA 支持 world ✓；
//   DAY_RANGE 仅接受数字 1..5，无 "last_1day" 写法 —— 省略 DATE 时即返回
//   "从今天起往前 DAY_RANGE 天的最近数据"，故以官方为准取 DAY_RANGE=1（等价最近 1 天）。
// 返回 CSV 文本（非 JSON），VIIRS 表头示例：
//   latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
// ------------------------------------------------------------
export async function fetchFIRMS(envKey: string | undefined): Promise<Fire[] | null> {
  // 无 FIRMS_KEY：跳过，返回 null，不报错（§2 防御性要求）
  if (!envKey) return null;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${envKey}/VIIRS_SNPP_NRT/world/1`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null; // HTTP 错 → 降级 null，不抛错
    return parseFirmsCsv(await res.text());
  } catch {
    return null; // 网络错/超时 → 降级 null，不抛错
  }
}

/**
 * FIRMS CSV → fires[]{lat,lon,frp,brightness}，top 100 by frp。
 * 表头驱动的列映射（不硬编码列号）；latitude/longitude/frp 关键列缺失或
 * 无数据行 → 返回 null（按补丁：解析失败降级，不抛错）。
 */
export function parseFirmsCsv(text: string): Fire[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) return null; // 空响应或只有表头 → 解析失败

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const iLat = header.indexOf("latitude");
  const iLon = header.indexOf("longitude");
  const iFrp = header.indexOf("frp");
  // brightness：VIIRS 列名 bright_ti4（≈MODIS 的 brightness），兼容两者
  const iBright = header.includes("bright_ti4")
    ? header.indexOf("bright_ti4")
    : header.indexOf("brightness");
  if (iLat < 0 || iLon < 0 || iFrp < 0) return null; // 关键列缺失

  const fires: Fire[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const lat = numOrNull(cols[iLat]);
    const lon = numOrNull(cols[iLon]);
    if (lat === null || lon === null) continue; // 坏行跳过
    fires.push({
      lat,
      lon,
      frp: numOrNull(cols[iFrp]),
      brightness: iBright >= 0 ? numOrNull(cols[iBright]) : null,
    });
  }
  if (fires.length === 0) return null;
  fires.sort((a, b) => (b.frp ?? -Infinity) - (a.frp ?? -Infinity));
  return fires.slice(0, 100); // top 100 by frp（§2）
}
