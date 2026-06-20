// 灵镜 音色服务 — 预置人声 + 克隆音色,克隆强制授权存证(与形象对称)。
//
// 决策来源:/plan-eng-review D10 + 外部声音#6 —— 克隆他人声音同样需"本人授权"凭证。

import { randomUUID } from 'node:crypto';
import { db, scopeByActor, type VoiceRow } from '../db/index.js';
import { TERMS_VERSION } from '../legal/index.js';

const now = () => Date.now();

// 预置人声 = Qwen-TTS 系统音色(走 HTTP,支持情绪指令 + 方言 + 多语种)。
// id 必须是 Qwen-TTS 模型的**合法 voice 参数名**(传给引擎的 voice;见
// https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list)。预置合成模型 = config.qwenTtsModel。
// 选 Qwen 而非 CosyVoice:CosyVoice v1 不支持情绪/方言;Qwen 音色原生支持情绪(instruct)+ 多方言。
const PRESETS: { id: string; name: string; lang: string; gender: string; desc: string }[] = [
  // —— 普通话 · 通用场景 ——
  { id: 'Cherry', name: '芊悦', lang: '中文', gender: '女', desc: '阳光亲切 · Vlog、短视频' },
  { id: 'Serena', name: '苏瑶', lang: '中文', gender: '女', desc: '温柔知性 · 有声书、播客' },
  { id: 'Ethan', name: '晨煦', lang: '中文', gender: '男', desc: '阳光活力 · 广告、宣传' },
  { id: 'Neil', name: '阿闻', lang: '中文', gender: '男', desc: '专业播音 · 新闻、纪录片' },
  { id: 'Andre', name: '安德雷', lang: '中文', gender: '男', desc: '磁性沉稳 · 品牌、纪录片' },
  { id: 'Maia', name: '四月', lang: '中文', gender: '女', desc: '知性温柔 · 有声书' },
  { id: 'Eldric Sage', name: '沧明子', lang: '中文', gender: '男', desc: '沉稳睿智 · 解说、纪录片' },
  { id: 'Bellona', name: '燕铮莺', lang: '中文', gender: '女', desc: '字正腔圆 · 播报、配音' },
  { id: 'Chelsie', name: '千雪', lang: '中文', gender: '女', desc: '二次元 · 动画、游戏' },
  { id: 'Moon', name: '月白', lang: '中文', gender: '男', desc: '率性帅气 · 角色配音' },
  { id: 'Seren', name: '小婉', lang: '中文', gender: '女', desc: '温和舒缓 · 助眠、冥想' },
  { id: 'Vincent', name: '田叔', lang: '中文', gender: '男', desc: '沙哑烟嗓 · 江湖、剧情' },
  // —— 方言 ——
  { id: 'Sunny', name: '四川-晴儿', lang: '四川话', gender: '女', desc: '甜美川妹子 · 方言配音' },
  { id: 'Eric', name: '四川-程川', lang: '四川话', gender: '男', desc: '市井成都男 · 方言配音' },
  { id: 'Rocky', name: '粤语-阿强', lang: '粤语', gender: '男', desc: '幽默风趣 · 粤语配音' },
  { id: 'Kiki', name: '粤语-阿清', lang: '粤语', gender: '女', desc: '甜美港妹 · 粤语配音' },
  { id: 'Dylan', name: '北京-晓东', lang: '北京话', gender: '男', desc: '胡同少年 · 方言配音' },
  { id: 'Jada', name: '上海-阿珍', lang: '上海话', gender: '女', desc: '沪上阿姐 · 方言配音' },
  { id: 'Peter', name: '天津-李彼得', lang: '天津话', gender: '男', desc: '天津相声 · 方言配音' },
  { id: 'Marcus', name: '陕西-秦川', lang: '陕西话', gender: '男', desc: '老陕味道 · 方言配音' },
];

/** 预置音色试听样本的存储 key(由 preset id 派生)。
 *  样本由 scripts/seed-preset-samples 合成后上传到此 key;内容为 WAV(Content-Type: audio/wav),故后缀 .wav。 */
export function presetSampleKey(presetId: string): string {
  return `voices/presets/${presetId}.wav`;
}

// 试听样本对所有部署都一样(同一句话、同 20 个音色),故托管在公共只读桶,
// 各部署共享直链 —— 运营零配置即有试听,无需配百炼/跑 seed。与预置形象缩略图同款(见 avatars/index.ts)。
// 想换桶/本地化:改这个 base 或叠加私有签名逻辑即可(见 TODOS T-SHOWCASE-ASSETS)。
const PRESET_SAMPLE_PUBLIC_BASE = 'https://lh-lingjing.oss-cn-hangzhou.aliyuncs.com';
/** 预置音色试听样本的公共直链(只读,所有部署共享)。
 *  对路径段做 URL 编码:有的 id 带空格(如 'Eldric Sage'),裸空格会让浏览器/OSS 取不到(实测 000)。 */
export function presetSampleUrl(presetId: string): string {
  // 仅编码各路径段,保留 '/' 分隔;空格→%20。
  const encodedKey = presetSampleKey(presetId).split('/').map(encodeURIComponent).join('/');
  return `${PRESET_SAMPLE_PUBLIC_BASE}/${encodedKey}`;
}

export function listPresets() {
  return PRESETS.map((p) => ({
    ...p,
    kind: 'preset' as const,
    status: 'ready' as const,
    sampleKey: presetSampleKey(p.id),
    sampleUrl: presetSampleUrl(p.id), // 公共直链试听
  }));
}
export function isPreset(ref: string): boolean {
  return PRESETS.some((p) => p.id === ref);
}

export interface CreateVoiceParams {
  tenantId: string;
  userId: string;
  name: string;
  sourceKey: string; // 样本音频已落 OSS/MinIO
  consent: boolean;
  proofKey?: string;
  providerVoiceId?: string; // 百炼声音复刻返回的 voice_id;有则状态 ready 且可合成本人声音
}

/** 克隆音色:强制授权,否则拒绝。先写 authorization 存证再建 voice。
 *  providerVoiceId 有 → 真实复刻已完成(status=ready,合成用本人声音);
 *  无 → 复刻未产出(降级),status=failed 让前端可见、避免误用。 */
export function createCloneVoice(p: CreateVoiceParams): VoiceRow {
  if (!p.consent) {
    const err = new Error('必须确认"已获被克隆人本人授权"才能克隆音色');
    (err as any).code = 'AUTHORIZATION_REQUIRED';
    throw err;
  }
  const authId = randomUUID();
  db.prepare(
    `INSERT INTO authorization (id,tenant_id,subject_type,consent,proof_key,terms_version,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(authId, p.tenantId, 'voice', 1, p.proofKey ?? null, TERMS_VERSION, p.userId, now());

  const v: VoiceRow = {
    id: randomUUID(),
    tenant_id: p.tenantId,
    name: p.name,
    kind: 'clone',
    status: p.providerVoiceId ? 'ready' : 'failed',
    source_key: p.sourceKey,
    provider_voice_id: p.providerVoiceId ?? null,
    authorization_id: authId,
    created_by: p.userId, // 账号隔离:创建者
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO voice (id,tenant_id,name,kind,status,source_key,provider_voice_id,authorization_id,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    v.id, v.tenant_id, v.name, v.kind, v.status, v.source_key, v.provider_voice_id,
    v.authorization_id, v.created_by, v.created_at,
  );
  return v;
}

export interface CreateDesignVoiceParams {
  tenantId: string;
  name: string;
  providerVoiceId: string; // Qwen 声音设计返回的 voice id(必有,否则 API 层已拒)
  userId: string; // 账号隔离:创建者(此前缺,导致 design voice created_by=NULL → 创作者自己也看不到)
}

/** 设计音色:纯文本描述生成的合成音色(非真人),无需授权存证(与克隆区别)。
 *  kind=design → resolveVoice 路由到 Qwen HTTP 合成(designModel)。 */
export function createDesignVoice(p: CreateDesignVoiceParams): VoiceRow {
  const v: VoiceRow = {
    id: randomUUID(),
    tenant_id: p.tenantId,
    name: p.name,
    kind: 'design',
    status: 'ready', // 设计音色创建即可用(provider_voice_id 必有)
    source_key: null, // 设计无音频样本
    provider_voice_id: p.providerVoiceId,
    authorization_id: null, // 合成音色无真人,无需授权
    created_by: p.userId, // 账号隔离:创建者
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO voice (id,tenant_id,name,kind,status,source_key,provider_voice_id,authorization_id,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    v.id, v.tenant_id, v.name, v.kind, v.status, v.source_key, v.provider_voice_id,
    v.authorization_id, v.created_by, v.created_at,
  );
  return v;
}

// ── 配额/限流闸(eng-review 张力2:防刷付费 Qwen 预览)──
/** 某租户自建音色(克隆+设计)总数。用于总数上限闸。 */
export function countCustomVoices(tenantId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM voice WHERE tenant_id=? AND kind IN ('clone','design')`)
    .get(tenantId) as { n: number };
  return row.n;
}
/** 某租户近 windowMs 内创建的设计音色数。用于创建频率闸。 */
export function countRecentDesignVoices(tenantId: string, windowMs: number): number {
  const since = now() - windowMs;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM voice WHERE tenant_id=? AND kind='design' AND created_at >= ?`,
    )
    .get(tenantId, since) as { n: number };
  return row.n;
}

/** 列自建音色。账号隔离:creator 仅自己建的;admin 全机构(含 NULL 老资产)。 */
export function listClones(tenantId: string, actingUserId: string, isAdmin: boolean): VoiceRow[] {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db
    .prepare(`SELECT * FROM voice WHERE tenant_id=?${scope.clause} ORDER BY created_at DESC`)
    .all(tenantId, ...scope.params) as VoiceRow[];
}
/** 取单个音色(账号隔离)。非本人非 admin → undefined → 路由 404。 */
export function getVoice(id: string, tenantId: string, actingUserId: string, isAdmin: boolean): VoiceRow | undefined {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db.prepare(`SELECT * FROM voice WHERE id=? AND tenant_id=?${scope.clause}`).get(id, tenantId, ...scope.params) as
    | VoiceRow
    | undefined;
}
export function deleteVoice(id: string, tenantId: string, actingUserId: string, isAdmin: boolean): boolean {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db.prepare(`DELETE FROM voice WHERE id=? AND tenant_id=?${scope.clause}`).run(id, tenantId, ...scope.params).changes === 1;
}
/** 校验 voiceRef 是否可用于生成。预置全员可用;自定义音色**账号隔离**(用户定:自己的不共享)。 */
export function isUsableVoice(ref: string, tenantId: string, actingUserId: string, isAdmin: boolean): boolean {
  if (isPreset(ref)) return true;
  const v = getVoice(ref, tenantId, actingUserId, isAdmin);
  return !!v && v.status === 'ready';
}
