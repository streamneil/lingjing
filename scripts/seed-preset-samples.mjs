#!/usr/bin/env node
// 灵镜 — 预置音色试听样本库(E9)。为每个预置人声合成一段固定试听句 → 落 MinIO。
// 用法:DASHSCOPE_API_KEY=sk-xxx npx tsx scripts/seed-preset-samples.mjs
//
// 一次性 / 幂等:已存在的样本默认跳过(传 --force 重新生成)。GET /voices 每请求签名该 key。
// 私有化部署:接好 MinIO + DASHSCOPE_API_KEY 后跑一次即可,预置音色便可在前端试听。

import { listPresets, presetSampleKey } from '../src/voices/index.ts';
import { synthesizeSpeech } from '../src/gateway/cosyvoice.ts';
import { putObject, getObject, ensureBucket } from '../src/storage/index.ts';
import { config } from '../src/config.ts';

const FORCE = process.argv.includes('--force');
// 固定试听句(中性、能体现音色特质;各预置同句便于横向对比)
const SAMPLE_TEXT = '你好,这是我的声音。希望它能为你的内容增添一份生动与温度。';

async function exists(key) {
  try {
    const buf = await getObject(key);
    return buf && buf.length > 0;
  } catch {
    return false;
  }
}

async function main() {
  await ensureBucket();
  const presets = listPresets();
  console.log(`\n预置音色试听样本:${presets.length} 个,合成句「${SAMPLE_TEXT}」\n`);

  let made = 0,
    skipped = 0,
    failed = 0;
  for (const p of presets) {
    const key = presetSampleKey(p.id);
    if (!FORCE && (await exists(key))) {
      console.log(`  跳过 ${p.id}(${p.name}):样本已存在`);
      skipped++;
      continue;
    }
    try {
      const buf = await synthesizeSpeech({
        text: SAMPLE_TEXT,
        voice: p.id,
        model: config.baichuan.ttsModel, // 预置音色名须配套 ttsModel(v1)
      });
      await putObject(key, buf, 'audio/mpeg');
      console.log(`  ✓ ${p.id}(${p.name}):${buf.length} bytes → ${key}`);
      made++;
    } catch (e) {
      console.warn(`  ✗ ${p.id}(${p.name}):合成失败 — ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  }
  console.log(`\n完成:新建 ${made},跳过 ${skipped},失败 ${failed}。\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('seed-preset-samples 崩:', e);
  process.exit(1);
});
