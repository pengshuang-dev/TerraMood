# Terra Mood Workers 聚合层 · 部署指南（Card 13-Rev v2）

> 目标：把 `workers/` 目录部署为一个 Cloudflare Worker（`terramood-api`），
> 定时拉取 6 大自然数据源 → 写入 KV → 对外提供 `GET /v1/now`，并绑定自定义域
> `api.trylinea.art`。全程约 10 分钟。

---

## 0. 前置条件

1. 一个 Cloudflare 账号（Free plan 也能跑，见附录 A 的 cron 数量说明）。
2. 本机已安装 Node.js ≥ 18。
3. （可选，绑定自定义域时需要）域名 `trylinea.art` 的 DNS 已托管在同一个
   Cloudflare 账号下。

```bash
cd workers
npm install          # 安装 wrangler / typescript / workers-types
npx wrangler login   # 会弹浏览器授权
```

> 注意：本目录（`workers/`）与仓库根部的 `worker/`（mood 服务）是两个独立
> Worker，互不影响。

---

## 1. 创建 KV 并回填 namespace id

```bash
wrangler kv namespace create TERRA_KV
```

命令输出中会有一段类似：

```toml
[[kv_namespaces]]
binding = "TERRA_KV"
id = "0a1b2c3d4e5f..."
```

把这个真实 `id` 粘贴进 `wrangler.toml`，替换占位符：

```toml
[[kv_namespaces]]
binding = "TERRA_KV"
id = "0a1b2c3d4e5f..."    # ← 换成你的
```

---

## 2. 注入 Secret：FIRMS_KEY

FIRMS 野火数据需要免费的 NASA MAP_KEY：

1. 打开 <https://firms.modaps.eosdis.nasa.gov/api/map_key/>，用邮箱申请
   MAP_KEY（免费，即时下发）。
2. 回到终端：

```bash
wrangler secret put FIRMS_KEY
# 提示输入时，粘贴你的 MAP_KEY 后回车
```

> 没申请 MAP_KEY 也能部署：FIRMS 源会自动跳过（`fires` 保持 `null`），其余
> 5 源照常工作，随时可后补。

---

## 3. 部署

```bash
wrangler deploy
```

成功后会输出 Worker 地址，例如 `https://terramood-api.<你的子域>.workers.dev`。

> 自定义域 `api.trylinea.art` 已在 `wrangler.toml` 中配置为 Custom Domain，
> 本次 deploy 就会自动创建解析并绑定 —— 见第 5 步。

---

## 4. 验证 /v1/now

```bash
# 1) Worker 活着
curl https://terramood-api.<你的子域>.workers.dev/
# → {"status":"ok","service":"terramood-api"}

# 2) 快照可能先返回 503（首轮 cron 还没跑完）
curl -i https://terramood-api.<你的子域>.workers.dev/v1/now
# 503 {"error":"snapshot not ready", ...}   ← 正常，最迟 15 分钟后自动就绪

# 3) 等 15 分钟后再试
curl https://terramood-api.<你的子域>.workers.dev/v1/now
# 200 {"freshness":"fresh","updatedAt":"...","data":{"quakes":[...],...}}
```

想立即灌满数据（可选）：本地起 dev 并手动触发各档 cron（写入的是本地模拟
KV，仅用于观察日志；生产 KV 由线上 cron 自动填充）：

```bash
npx wrangler dev --test-scheduled
# 另开一个终端：
curl "http://localhost:8787/__scheduled?cron=0+0+*+*+*"   # 未知表达式会触发全量聚合
```

---

## 5. api.trylinea.art 访问（已自动配置，无需手动解析）

`wrangler.toml` 已采用 **Custom Domain** 模式：

```toml
routes = [
  { pattern = "api.trylinea.art", custom_domain = true }
]
```

执行 `wrangler deploy`（或 `./deploy.sh`）时，Wrangler 会自动：

1. 在 `trylinea.art` zone 下**创建 `api` 子域的 DNS 解析记录**
   （你无需手动加 AAAA 记录或开关代理）；
2. 把 `api.trylinea.art` 整个子域路由到本 Worker（`/v1/now` 等路径由
   Worker 内部区分，未知路径返回 404 JSON）。

验证（绑定完成有 1-2 分钟 DNS 生效延迟）：

```bash
curl -i https://api.trylinea.art/v1/now
```

**若 deploy 报 zone 相关错误**（`zone not found` / `zone is pending`）：
到 Dashboard → Websites 确认 `trylinea.art` 状态为 **Active**（域名 NS 已
切到 Cloudflare）。zone 处于 pending 状态时无法创建 Custom Domain，需先
完成 NS 切换再重跑 `./deploy.sh`。

> 备注：也可以改用普通 Route 方式（pattern `api.trylinea.art/v1/*`，再到
> DNS 页手动加 AAAA 记录：名称 `api`、内容 `100::`、开橙云代理）。但既然
> 子域解析还没配，Custom Domain 全自动最省事；同一 hostname 两种方式二选一。

---

## 6. 验收：模拟 USGS 500（单源故障演练）

目的：验证降级 Ladder —— 单源挂了，`/v1/now` 仍返回其余源，且
`freshness="stale"`。

1. 本地起 dev：

```bash
npx wrangler dev --test-scheduled
```

2. 临时把 `src/fetchers.ts` 里 `fetchUSGS` 的 URL 尾部改成无效路径（模拟
   500，例如 `.../all_hour.geojson.broken`），保存（dev 会热重载）。
3. 触发 USGS 档 cron：

```bash
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"
```

4. 读快照：

```bash
curl http://localhost:8787/v1/now
```

预期结果：

* `data.quakes` 仍为**历史值**（第一次触发时为 `null`，因为还没有历史值可留）；
* 其余源（storms / aurora / cloud / volcanoes …）照常返回；
* `freshness: "stale"`，且 `sources.usgs.ok == false`、`error` 含失败原因。

5. 验完把 URL 改回原样即可。

---

## 附录 A · Free plan 的 cron 数量限制

免费版每个 Worker 最多 **3 条** cron（付费版 60 条）。本目录 `wrangler.toml`
默认写了 5 条（Paid 配置）。免费版请改成下面 3 条：

```toml
[triggers]
crons = [
  "*/15 * * * *",  # USGS
  "*/30 * * * *",  # SWPC ovation + Kp
  "0 */6 * * *",   # NHC + EONET + FIRMS + GIBS（聚合器已兼容此合并档）
]
```

`src/index.ts` 的聚合器对 `"0 */6 * * *"` 会同时跑 NHC / EONET / FIRMS /
GIBS（NHC 从 3h 档放宽到 6h，其余不变），**无需改任何代码**。

---

## 附录 B · 端点与任务卡 §2 的偏差说明（以官方为准）

| 源 | §2 原文 | 官方实测 / 文档 | 代码取值 |
| --- | --- | --- | --- |
| FIRMS | `.../world/last_1day` | Area API `DAY_RANGE` 仅接受数字 1..5；省略 DATE 即"最近 1 天" | `.../world/1` |
| FIRMS 返回格式 | JSON 数组 | Area CSV 端点返回 CSV 文本（补丁已指定 CSV） | CSV 表头解析 |
| SWPC Kp | 行式数组 `[tag,time,...,kp]` | 现为对象数组 `{"time_tag","Kp",...}`（2026-09 核对） | 取最后一项 `Kp`，旧行式留兜底 |
| GIBS | `GoogleMapsCompatibleLevel9` | 官方 TileMatrixSet 为 `GoogleMapsCompatible_Level9`（带下划线） | 带下划线 |
| EONET | `geometry.coordinates` | v3 中 `events[].geometry` 是数组，取最新一条 | 最后一个元素的 coordinates |

其余端点与 §2 完全一致，可直接 grep `workers/src/fetchers.ts` 核对。

---

## 常见问题

* **`wrangler deploy` 报 KV id 无效**：`wrangler.toml` 里的
  `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 还没替换（第 1 步）。
* **`/v1/now` 一直 503**：确认 `wrangler.toml` 的 crons 已生效（部署输出里
  会列出 schedules）；或手动 `curl "https://terramood-api.<子域>.workers.dev/__scheduled"` —— 注意 `__scheduled` 仅在
  `wrangler dev` 本地可用，线上等 cron 即可。
* **`fires` 一直是 `null`**：FIRMS_KEY 未注入（第 2 步），或该次拉取失败
  （看 `sources.firms.error` 字段）。
