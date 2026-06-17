// 一次性脚本:把 Doubao Seedance 2.0 文档「多模态参考」茶广告示例素材
// 从火山 TOS 示例 URL 下载转存到本平台存储(阿里云 OSS,永久),固化 key 供 ref-video 示范卡。
//
// 为什么:文档 TOS URL 会过期(eng-review 外部声音 #7),示范卡若直引 TOS 链上线当天就坏。
// 运行:npx tsx scripts/seed-ref-video-demo.ts
//   需 .env 配好 OSS(OSS_REGION/BUCKET/ACCESS_KEY_ID/ACCESS_KEY_SECRET);否则落本地 MinIO。
// 输出:打印固化的 demo key(已硬编进 prototype/ref-video.html 的 DEMO 常量,key 不变则无需改前端)。

import { putObjectFromUrl, getSignedUrl, storageBackendName } from '../src/storage/index.js';

// 文档「多模态参考」茶广告示例(prompt + 2图 + 1视频 + 1音频 + 输出视频)。
const DEMO = {
  prompt: '全程使用视频1的第一视角构图,全程使用音频1作为背景音乐。第一人称视角果茶宣传广告,seedance牌「苹苹安安」苹果果茶限定款;首帧为图片1,你的手摘下一颗带晨露的阿克苏红苹果;6-8 秒第一人称手持举杯,将图片2中的果茶举到镜头前,尾帧定格为图片2。背景声音统一为女生音色。',
  assets: [
    { key: 'ref-video-demo/tea/pic1.jpg',   url: 'https://ark-project.tos-cn-beijing.volces.com/doc_image/r2v_tea_pic1.jpg' },
    { key: 'ref-video-demo/tea/pic2.jpg',   url: 'https://ark-project.tos-cn-beijing.volces.com/doc_image/r2v_tea_pic2.jpg' },
    { key: 'ref-video-demo/tea/video1.mp4', url: 'https://ark-project.tos-cn-beijing.volces.com/doc_video/r2v_tea_video1.mp4' },
    { key: 'ref-video-demo/tea/audio1.mp3', url: 'https://ark-project.tos-cn-beijing.volces.com/doc_audio/r2v_tea_audio1.mp3' },
    { key: 'ref-video-demo/tea/output.mp4', url: 'https://p9-arcosite.byteimg.com/obj/tos-cn-i-goo7wpa0wc/dab46ce2289a4a8ead76711bb02f2e1d' },
  ],
} as const;

async function main() {
  console.log(`[seed-demo] storage backend = ${storageBackendName}`);
  for (const a of DEMO.assets) {
    try {
      await putObjectFromUrl(a.key, a.url);
      const signed = await getSignedUrl(a.key, 60).catch(() => '(sign failed)');
      console.log(`[seed-demo] ✓ ${a.key}  ← ${a.url}\n            signed: ${signed.slice(0, 80)}...`);
    } catch (e) {
      console.error(`[seed-demo] ✗ ${a.key}: ${e instanceof Error ? e.message : e}`);
      console.error('            (TOS 示例 URL 可能已过期 — 需换成可用的素材源)');
    }
  }
  console.log('\n[seed-demo] 完成。前端示范卡的 DEMO key 已与本脚本一致,key 不变则无需改 ref-video.html。');
}

main().catch((e) => { console.error(e); process.exit(1); });
