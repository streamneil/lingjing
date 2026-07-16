// 火山私域素材库 端到端诊断(给对接方确认用)。
//
// 跑法(.env 已填 ARK_ASSET_AK/SK):
//   npx tsx scripts/ark-asset-diagnose.ts
//   npx tsx scripts/ark-asset-diagnose.ts "<公网可访问的人脸图 URL>"   # 带图=多测入库审核
//
// 逐步跑,不因某步失败中断;每步打印 通过/失败 + 火山原始响应,末尾给结论。
// 目的:精确定位卡在 [签名] / [IAM 权限] / [权益包] / [审核] / [project] 哪一环。

import { createAssetGroup, createAsset, getAsset } from '../src/gateway/ark-assets-client.js';
import { config } from '../src/config.js';

function line() { console.log('─'.repeat(64)); }

async function main(): Promise<void> {
  const imageUrl = process.argv[2];
  const project = config.arkAssets.projectName;

  line();
  console.log('火山私域素材库 端到端诊断');
  line();
  console.log(`ARK_ASSET_LIBRARY_ENABLED = ${config.arkAssets.enabled}`);
  console.log(`ARK_ASSET_PROJECT         = ${project || '(空 = default)'}`);
  console.log(`ARK_ASSET_AK 前缀          = ${config.arkAssets.accessKeyId.slice(0, 4)}…(长度 ${config.arkAssets.accessKeyId.length})`);
  console.log(`ARK_ASSET_SK               = ${config.arkAssets.secretAccessKey ? '已填(隐藏)' : '空!'}`);
  console.log(`测试人脸图 URL             = ${imageUrl ?? '(未提供,跳过入库/审核测试)'}`);
  line();

  // ── 步骤 A:CreateAssetGroup(测 签名 + IAM 权限 + 权益包 + 账号)──
  let groupId: string | undefined;
  try {
    groupId = await createAssetGroup('lingjing-diagnose', project);
    console.log(`[A] CreateAssetGroup  ✅ 通过  → group id = ${groupId}`);
    console.log('    含义:AK/SK 签名正确 + IAM 有 ark:CreateAssetGroup 权限 + 素材库可用。');
  } catch (e) {
    console.log(`[A] CreateAssetGroup  ❌ 失败`);
    console.log(`    火山原始:${(e as Error).message}`);
    console.log('    → 若为 403 AccessDenied ark:*Asset* :缺 IAM 权限(见报告"对接方须做")。');
    console.log('    → 若为 权益/未开通       :高级创作权益包未在本账号开通。');
    console.log('    → 若为 签名/SignatureDoesNotMatch:AK/SK 或时钟问题。');
    line();
    console.log('结论:卡在 [A],后续步骤无法进行。把上面"火山原始"整行发对接方。');
    line();
    return;
  }

  // ── 步骤 B:CreateAsset(需人脸图 URL;测 入库受理)──
  if (!imageUrl) {
    line();
    console.log('结论:[A] 通过。请带一张公网可访问的人脸图 URL 再跑一次,继续测 [B][C]:');
    console.log('  npx tsx scripts/ark-asset-diagnose.ts "https://.../face.jpg"');
    line();
    return;
  }
  let assetId: string | undefined;
  try {
    assetId = await createAsset(groupId, imageUrl, project);
    console.log(`[B] CreateAsset       ✅ 受理  → asset id = ${assetId}`);
  } catch (e) {
    console.log(`[B] CreateAsset       ❌ 失败`);
    console.log(`    火山原始:${(e as Error).message}`);
    line();
    console.log('结论:入库受理失败(常见:URL 火山拉不到 / 缺 ark:CreateAsset 权限)。发对接方。');
    line();
    return;
  }

  // ── 步骤 C:轮询 GetAsset(测 审核结果 Active/Failed)──
  console.log('[C] 轮询 GetAsset 至 Active/Failed(最多 ~60s)…');
  const deadline = Date.now() + 60_000;
  let final = 'Processing';
  while (Date.now() < deadline) {
    const info = await getAsset(assetId, project);
    final = info.status;
    console.log(`    状态:${info.status}`);
    if (info.status === 'Active') {
      console.log(`[C] 审核             ✅ Active  → 可用 asset://${assetId}`);
      break;
    }
    if (info.status === 'Failed') {
      console.log('[C] 审核             ❌ Failed  → 该图被素材库审核拒绝');
      console.log('    含义:极可能是"真实真人脸"——虚拟人像通道不接受,需被拍摄者本人活体认证。');
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  line();
  if (final === 'Active') {
    console.log('结论:素材库全链路通(签名+权限+权益包+审核)。若生成仍被拦 → project 不一致:');
    console.log('  素材在 project=' + (project || 'default') + ',确认调用模型的 ark- key 也在同一 project。');
  } else if (final === 'Failed') {
    console.log('结论:入库通,但这张脸审核不过(真人脸需活体认证,非本方案能解)。换虚拟/自有形象再测。');
  } else {
    console.log('结论:60s 仍 Processing(火山排队慢)。稍后重跑用同图会命中已入库资产继续查。');
  }
  line();
}

main().catch((e: Error) => {
  console.error(`诊断脚本异常:${e.message}`);
  process.exit(1);
});
