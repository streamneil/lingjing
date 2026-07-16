// 真机验证:用 .env 里的真实 AK/SK 打一发 CreateAssetGroup,确认签名/端点/权益包/project 都对。
//
// 跑法:先在 .env 填 ARK_ASSET_AK / ARK_ASSET_SK(和可选 ARK_ASSET_PROJECT),再:
//   npx tsx scripts/ark-asset-spike.ts
//
// 期望:打印出 group id(group-...)。
// 若报签名/HTTP 403 → 对 @volcengine/openapi README 校 signedArkCall 的 requestData 字段。
// 若报无权限/未开通 → 回业务侧确认高级创作权益包 + IAM ark:*Asset*。
// 若这里通了但生成仍失败 → project 不一致,填 ARK_ASSET_PROJECT(见计划 Task 6 排障表)。

import { createAssetGroup } from '../src/gateway/ark-assets-client.js';
import { config } from '../src/config.js';

async function main(): Promise<void> {
  const project = config.arkAssets.projectName;
  console.log(`[spike] project = ${project || '(default)'}`);
  const id = await createAssetGroup('lingjing-spike', project);
  console.log(`[spike] OK, group id = ${id}`);
}

main().catch((e: Error) => {
  console.error(`[spike] 失败:${e.message}`);
  process.exit(1);
});
