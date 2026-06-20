#!/usr/bin/env node
// 灵镜 — 平台数据一键种子。部署后跑一次,让平台「开箱即数据完整」。
//
//   DB_FILE=/data/lingjing.db npx tsx scripts/seed-platform.mjs
//
// 灌默认积分套餐(幂等:表非空则跳过,不覆盖运营已改的)。无需任何 key,瞬时完成。
//
// 无需本脚本处理的(天生就有):
//   · 落地页/探索灵感图文、预置形象/声音元数据、预置音色试听小样 —— 公共只读资源
//     (随前端引用公共桶 lh-lingjing)+ 随代码常量,部署即有,无需种子。详见 DEPLOY-ALIYUN.md。
//   · 仅私有化内网(访问不到公共桶)才需把音色小样灌进自己桶:scripts/seed-preset-samples.mjs。

import { seedDefaultPlans } from '../src/pricing/index.ts';

const n = seedDefaultPlans();
console.log(
  n > 0
    ? `[seed] ✓ 已灌默认积分套餐 ${n} 个(之后在 /admin 可改价/增删)`
    : '[seed] ℹ pricing_plan 已有套餐,跳过(不覆盖)',
);
console.log('[seed] 完成。示范图文 + 预置音色试听走公共桶,已自带,无需额外种子。');
