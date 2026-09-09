// ============================================================
// Card 13-Rev v2 · Workers 聚合层入口
//   GET /v1/now   → 读 KV 快照原样返回（不回源，单点故障不崩 API）
//   scheduled     → 按 cron 分级拉取 → 合并写 KV（单源失败保留历史值 → freshness="stale"）
// 降级 Ladder：单源 fetch 失败 → catch → 保留 KV 该源历史值 → 整体 freshness="stale"。
// ============================================================

import type { Aurora, Snapshot, SourceKey, SourceState } from "./types";
import {
  fetchEONET,
  fetchFIRMS,
  fetchGIBS,
  fetchKp,
  fetchNHC,
  fetchOvation,
  fetchUSGS,
} from "./fetchers";

export interface Env {
  TERRA_KV: KVNamespace;
  /** NASA FIRMS MAP_KEY（Secret）；缺失时 FIRMS 源跳过，返回 null，不报错 */
  FIRMS_KEY?: string;
}

const SNAPSHOT_KEY = "now:snapshot";
/** 36h > 最慢 cron（日更），防快照彻底过期导致 /v1/now 503 */
const KV_TTL_SECONDS = 60 * 60 * 36;

const KNOWN_CRONS = new Set([
  "*/15 * * * *", // USGS
  "*/30 * * * *", // SWPC ovation + Kp
  "0 */3 * * *", // NHC
  "0 */6 * * *", // EONET + FIRMS
  "0 0 * * *", // GIBS
]);

function nowIso(): string {
  return new Date().toISOString();
}

function freshState(): SourceState {
  return { updatedAt: null, ok: true, error: null };
}

function withAurora(cur: Aurora | null, patch: Partial<Aurora>): Aurora {
  return { ovationMax: cur?.ovationMax ?? null, kp: cur?.kp ?? null, ...patch };
}

/** 读现有快照；不存在/损坏则给空骨架（源状态初始 ok=true，等首轮聚合逐个填充） */
async function loadSnapshot(env: Env): Promise<Snapshot> {
  const raw = await env.TERRA_KV.get(SNAPSHOT_KEY);
  if (raw) {
    try {
      const snap = JSON.parse(raw) as Snapshot;
      if (snap && snap.data && snap.sources) return snap;
    } catch {
      // 坏 JSON → 落到空骨架重建
    }
  }
  return {
    freshness: "fresh",
    updatedAt: nowIso(),
    data: {
      quakes: null,
      storms: null,
      aurora: null,
      cloud: null,
      volcanoes: null,
      fires: null,
    },
    sources: {
      usgs: freshState(),
      nhc: freshState(),
      swpcOvation: freshState(),
      swpcKp: freshState(),
      gibs: freshState(),
      eonet: freshState(),
      firms: freshState(),
    },
  };
}

type Attempt = () => Promise<boolean>; // true = 拿到新数据；false = 本次失败

/** 单源执行器：成功记账 updatedAt；失败保留快照中该源历史值（降级核心） */
async function runSource(
  snap: Snapshot,
  key: SourceKey,
  attempt: Attempt,
): Promise<void> {
  const st = snap.sources[key];
  try {
    if (await attempt()) {
      st.ok = true;
      st.error = null;
      st.updatedAt = nowIso();
    } else {
      st.ok = false;
      st.error = `${key}: fetch returned null (degraded, previous value kept)`;
    }
  } catch (e) {
    st.ok = false;
    st.error = `${key}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * 聚合一次：只跑「本次 cron 到期」的源（含该源从未成功时的补跑 backfill，
 * 部署后首个 cron 触发即可把全部源填齐）；未知表达式 → 全量跑。
 */
async function aggregate(env: Env, cron: string): Promise<void> {
  const snap = await loadSnapshot(env);
  const full = !KNOWN_CRONS.has(cron); // 防御：表达式变更时兜底全量
  const is6h = cron === "0 */6 * * *";
  const isMidnight = cron === "0 0 * * *";

  // --- USGS（*/15）---
  if (full || cron === "*/15 * * * *" || snap.sources.usgs.updatedAt === null) {
    await runSource(snap, "usgs", async () => {
      const quakes = await fetchUSGS();
      if (!quakes) return false;
      snap.data.quakes = quakes;
      return true;
    });
  }

  // --- SWPC 极光 + Kp（*/30）---
  if (full || cron === "*/30 * * * *" || snap.sources.swpcOvation.updatedAt === null) {
    await runSource(snap, "swpcOvation", async () => {
      const v = await fetchOvation();
      if (v === null) return false;
      snap.data.aurora = withAurora(snap.data.aurora, { ovationMax: v });
      return true;
    });
  }
  if (full || cron === "*/30 * * * *" || snap.sources.swpcKp.updatedAt === null) {
    await runSource(snap, "swpcKp", async () => {
      const v = await fetchKp();
      if (v === null) return false;
      snap.data.aurora = withAurora(snap.data.aurora, { kp: v });
      return true;
    });
  }

  // --- NHC（0 */3；Free plan 合并方案下随 6h 档更新，见 DEPLOY_GUIDE 附录 A）---
  if (full || cron === "0 */3 * * *" || is6h || snap.sources.nhc.updatedAt === null) {
    await runSource(snap, "nhc", async () => {
      const storms = await fetchNHC();
      if (!storms) return false;
      snap.data.storms = storms;
      return true;
    });
  }

  // --- EONET 火山（0 */6）---
  if (full || is6h || snap.sources.eonet.updatedAt === null) {
    await runSource(snap, "eonet", async () => {
      const volcanoes = await fetchEONET();
      if (!volcanoes) return false;
      snap.data.volcanoes = volcanoes;
      return true;
    });
  }

  // --- FIRMS 野火（0 */6；Secret FIRMS_KEY）---
  if (full || is6h || snap.sources.firms.updatedAt === null) {
    await runSource(snap, "firms", async () => {
      const fires = await fetchFIRMS(env.FIRMS_KEY);
      if (!fires) return false; // 无 key / HTTP 错 / 解析失败 → 降级
      snap.data.fires = fires;
      return true;
    });
  }

  // --- GIBS 云（0 0；纯本地计算恒成功，6h 档顺带刷新无害）---
  if (full || isMidnight || is6h || snap.sources.gibs.updatedAt === null) {
    snap.data.cloud = fetchGIBS();
    snap.sources.gibs = { updatedAt: nowIso(), ok: true, error: null };
  }

  // --- freshness & 落 KV ---
  snap.freshness = Object.values(snap.sources).some((s) => !s.ok)
    ? "stale"
    : "fresh";
  snap.updatedAt = nowIso();
  await env.TERRA_KV.put(SNAPSHOT_KEY, JSON.stringify(snap), {
    expirationTtl: KV_TTL_SECONDS,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=60",
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/v1/now") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { "access-control-allow-origin": "*" },
        });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse({ error: "method not allowed" }, 405);
      }
      const raw = await env.TERRA_KV.get(SNAPSHOT_KEY);
      if (!raw) {
        // 快照未就绪：cron 首轮未跑完。绝不回源拉 6 源（防雪崩）。
        return jsonResponse(
          {
            error: "snapshot not ready",
            hint: "首轮聚合尚未完成，请稍后重试（最迟 15 分钟后 USGS cron 会触发）",
          },
          503,
        );
      }
      return new Response(raw, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=60",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/healthz") {
      return jsonResponse({ status: "ok", service: "terramood-api" });
    }

    return jsonResponse({ error: "not found" }, 404);
  },

  async scheduled(event, env): Promise<void> {
    await aggregate(env, event.cron);
  },
} satisfies ExportedHandler<Env>;
