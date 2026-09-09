#!/usr/bin/env bash
# ============================================================
# Terra Mood Workers 一键部署脚本（Card 13-Rev v2）
# 用法:  chmod +x deploy.sh && ./deploy.sh
# 自动完成: 依赖安装 → KV 创建并回填 id → FIRMS_KEY(可选) → wrangler deploy
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"  # 始终以 workers/ 为工作目录

# ---------- 1) 前置检查 ----------
command -v node >/dev/null 2>&1 || { echo "✗ 未找到 node，请先安装 Node.js >= 18"; exit 1; }

WRANGLER=(npx wrangler)
if [ -x node_modules/.bin/wrangler ]; then
  WRANGLER=(node_modules/.bin/wrangler)
fi

# ---------- 2) 依赖安装（首次） ----------
if [ ! -d node_modules ]; then
  echo "==> 首次运行: npm install ..."
  npm install
fi

# ---------- 3) 登录检查 ----------
if ! "${WRANGLER[@]}" whoami >/dev/null 2>&1; then
  echo "✗ wrangler 未登录，请先执行: npx wrangler login"; exit 1
fi
echo "==> 已登录 Cloudflare"

# ---------- 4) KV namespace：未创建则创建并回填 wrangler.toml ----------
if grep -q "REPLACE_WITH_YOUR_KV_NAMESPACE_ID" wrangler.toml; then
  echo "==> 创建 KV namespace: TERRA_KV ..."
  KV_OUT=$("${WRANGLER[@]}" kv namespace create TERRA_KV 2>&1) || {
    echo "$KV_OUT"; echo "✗ KV 创建失败，请按 DEPLOY_GUIDE.md 第 1 步手动处理"; exit 1; }
  KV_ID=$(printf '%s' "$KV_OUT" | grep -Eo 'id = "[a-f0-9]{16,}"' | head -1 | sed -E 's/id = "([a-f0-9]+)"/\1/')
  if [ -z "$KV_ID" ]; then
    echo "$KV_OUT"
    echo "✗ 未能从输出解析 KV id，请手动复制回填 wrangler.toml"; exit 1
  fi
  # macOS 与 GNU sed 的 -i 语法不同，做兼容
  if sed --version >/dev/null 2>&1; then SED_I=(sed -i); else SED_I=(sed -i ''); fi
  "${SED_I[@]}" "s/REPLACE_WITH_YOUR_KV_NAMESPACE_ID/$KV_ID/" wrangler.toml
  echo "==> KV id 已回填 wrangler.toml: $KV_ID"
fi

# ---------- 5) FIRMS_KEY（可选 Secret）----------
if ! "${WRANGLER[@]}" secret list 2>/dev/null | grep -q "FIRMS_KEY"; then
  echo "==> 未检测到 Secret: FIRMS_KEY"
  echo "    （NASA FIRMS MAP_KEY 免费申请: https://firms.modaps.eosdis.nasa.gov/api/map_key/）"
  printf '现在输入 MAP_KEY 并回车；直接回车跳过（FIRMS 源停用，其余 5 源正常）: '
  read -rs FIRMS_KEY_INPUT || true # -s 静默不回显密钥；|| true 防非交互环境 EOF 中断
  echo
  if [ -n "$FIRMS_KEY_INPUT" ]; then
    printf '%s' "$FIRMS_KEY_INPUT" | "${WRANGLER[@]}" secret put FIRMS_KEY
  else
    echo "==> 跳过 FIRMS_KEY（可随时补: npx wrangler secret put FIRMS_KEY）"
  fi
else
  echo "==> FIRMS_KEY 已存在，跳过"
fi

# ---------- 6) 部署 ----------
echo "==> wrangler deploy ..."
if ! "${WRANGLER[@]}" deploy; then
  cat <<'EOF'

✗ deploy 失败。常见原因排查：
   - 报 cron triggers 超限（Free plan 限 3 条）→ 按 DEPLOY_GUIDE.md 附录 A
     把 crons 合并为 3 条后重跑本脚本
   - 报 zone not found / zone is pending → trylinea.art 的 NS 尚未切到
     Cloudflare；Dashboard → Websites 确认状态为 Active 后重跑
   - 报 KV namespace 无效 → 检查 wrangler.toml 的 id（脚本应已自动回填）
EOF
  exit 1
fi

# ---------- 7) 完成提示 ----------
cat <<'EOF'

✅ 部署完成。验证步骤：
   1) curl -i https://api.trylinea.art/v1/now
      → 先 503（首轮 cron 未跑完），最迟 15 分钟后变 200
      （custom_domain 已自动创建解析；刚绑定完可能有 1-2 分钟 DNS 生效延迟）
   2) 备用地址: curl https://terramood-api.<你的子域>.workers.dev/v1/now
   3) Free plan 若 deploy 报 cron 超 3 条：按 DEPLOY_GUIDE.md 附录 A
      把 crons 合并成 3 条后重跑本脚本
   4) 若 deploy 报 zone 相关错误（如 zone not found / pending）：
      到 Dashboard 确认 trylinea.art 状态为 Active（NS 已切到 Cloudflare）
EOF
