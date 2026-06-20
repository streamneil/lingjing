// 灵镜 形象服务 — 预置 + 自定义形象,自定义强制授权存证。
//
// 决策来源:/plan-eng-review D10 + 外部声音#6 —— 创建自定义形象(上传他人肖像)
// 必须留"本人授权"凭证。未授权直接拒绝(政企法律门票 + 百炼接口可能硬性要求)。

import { randomUUID } from 'node:crypto';
import { db, scopeByActor, type AvatarRow, type AvatarKind } from '../db/index.js';
import { TERMS_VERSION } from '../legal/index.js';

const now = () => Date.now();

// 预置形象(不入库,所有租户共享;平台自有授权素材,无授权问题)。
// 带 gender/orientation/scene 元数据供 C5 筛选。
// thumbKey = 桶 key(showcase/<f>),随 git 进 prototype/showcase/。两条消费路径(去中心化):
//   · 展示缩略图 → /api/showcase-asset/<f>(签名重定向自己桶 / 本地兜底,见 showcaseAssetUrl)。
//   · 视频生成源帧 → worker.resolveImageUrl 走 getMediaPublisher().publish(thumbKey)(百炼可拉,与自定义形象同路径)。
const PRESETS: {
  id: string; name: string; thumbKey: string;
  gender: 'male' | 'female'; orientation: 'portrait' | 'landscape'; scene: string;
}[] = [
  { id: 'preset-1', name: '田野记者 · 夏穗', gender: 'female', orientation: 'portrait', scene: '出镜', thumbKey: 'showcase/avatar-preset-1.png' },
  { id: 'preset-2', name: '科技主播 · 林溪', gender: 'female', orientation: 'portrait', scene: '科技', thumbKey: 'showcase/avatar-preset-2.png' },
  { id: 'preset-3', name: '文博讲解 · 苏窈', gender: 'female', orientation: 'portrait', scene: '文博', thumbKey: 'showcase/avatar-preset-3.png' },
  { id: 'preset-4', name: '时政主播 · 安宁', gender: 'female', orientation: 'portrait', scene: '新闻', thumbKey: 'showcase/avatar-preset-4.png' },
  { id: 'preset-5', name: '访谈主持 · 云岚', gender: 'female', orientation: 'portrait', scene: '访谈', thumbKey: 'showcase/avatar-preset-5.png' },
  { id: 'preset-6', name: '现场记者 · 程笑', gender: 'female', orientation: 'portrait', scene: '出镜', thumbKey: 'showcase/avatar-preset-6.png' },
  { id: 'preset-7', name: '新闻主播 · 叶澜', gender: 'female', orientation: 'portrait', scene: '新闻', thumbKey: 'showcase/avatar-preset-7.png' },
  // 探索灵感库「数字人」示范脸入库为预置,供「去做同款数字人」?avatar= 预选(id 与 explore 映射一致)。
  { id: 'preset-sage', name: '睿智长者 · 松鹤', gender: 'male', orientation: 'portrait', scene: '访谈', thumbKey: 'showcase/portrait-sage.jpg' },
  { id: 'preset-grandma', name: '慈祥长辈 · 秀兰', gender: 'female', orientation: 'portrait', scene: '生活', thumbKey: 'showcase/portrait-grandma.jpg' },
  { id: 'preset-girl', name: '元气少女 · 桃夭', gender: 'female', orientation: 'portrait', scene: '生活', thumbKey: 'showcase/girl-rainbow.jpg' },
];

/** 桶 key(showcase/<f>)→ 展示用 URL(本端点;段编码)。供前端缩略图。 */
export function showcaseAssetUrl(key: string): string {
  const sub = key.replace(/^showcase\//, '');
  return `/api/showcase-asset/${sub.split('/').map(encodeURIComponent).join('/')}`;
}

/** 预置形象(不入库,直接返回;所有租户共享)。thumb=展示 URL;thumbKey=源帧 key(worker 用)。 */
export function listPresets() {
  return PRESETS.map((p) => ({
    ...p,
    thumb: showcaseAssetUrl(p.thumbKey), // 展示缩略图走本端点(去中心化)
    kind: 'preset' as const,
    status: 'ready' as const,
  }));
}

export function isPreset(avatarRef: string): boolean {
  return PRESETS.some((p) => p.id === avatarRef);
}

export interface CreateAvatarParams {
  tenantId: string;
  userId: string;
  name: string;
  kind: AvatarKind; // photo | video
  sourceKey: string; // 已落 MinIO 的源素材 key
  consent: boolean; // 是否勾选"已获本人授权"
  proofKey?: string; // 授权凭证文件 key
  orientation?: 'portrait' | 'landscape' | 'square'; // 横竖比(C5 筛选)
}

/**
 * 创建自定义形象。强制授权:consent 必须为 true,否则抛错(合规门票)。
 * 先写 authorization 凭证,再建 avatar 关联它 —— 留可追溯的存证链。
 */
export function createCustomAvatar(p: CreateAvatarParams): AvatarRow {
  if (!p.consent) {
    const err = new Error('必须确认"已获被克隆人本人授权"才能创建自定义形象');
    (err as any).code = 'AUTHORIZATION_REQUIRED';
    throw err;
  }

  const authId = randomUUID();
  db.prepare(
    `INSERT INTO authorization (id,tenant_id,subject_type,consent,proof_key,terms_version,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(authId, p.tenantId, 'avatar', 1, p.proofKey ?? null, TERMS_VERSION, p.userId, now());

  const av: AvatarRow = {
    id: randomUUID(),
    tenant_id: p.tenantId,
    name: p.name,
    kind: p.kind,
    // Slice1:照片即时可用(预置能力);真实接百炼 createAvatar 后改为 processing→ready
    status: 'ready',
    source_key: p.sourceKey,
    thumb_url: p.sourceKey, // 自定义用源图当缩略(签名 URL 在 API 层生成)
    authorization_id: authId,
    orientation: p.orientation ?? 'portrait',
    is_default: 0,
    created_by: p.userId, // 账号隔离:创建者
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO avatar (id,tenant_id,name,kind,status,source_key,thumb_url,authorization_id,orientation,is_default,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(av.id, av.tenant_id, av.name, av.kind, av.status, av.source_key, av.thumb_url, av.authorization_id, av.orientation, av.is_default, av.created_by, av.created_at);
  return av;
}

/** C6:重命名形象(账号隔离:creator 仅改自己的;admin 任意)。 */
export function renameAvatar(id: string, tenantId: string, name: string, actingUserId: string, isAdmin: boolean): boolean {
  const scope = scopeByActor(actingUserId, isAdmin);
  const res = db.prepare(`UPDATE avatar SET name=? WHERE id=? AND tenant_id=?${scope.clause}`).run(name, id, tenantId, ...scope.params);
  return res.changes === 1;
}

/** C6:设为默认形象(同租户内互斥,事务保证只有一个默认)。 */
export const setDefaultAvatar = db.transaction((id: string, tenantId: string): boolean => {
  const exists = db.prepare(`SELECT 1 FROM avatar WHERE id=? AND tenant_id=?`).get(id, tenantId);
  if (!exists) return false;
  db.prepare(`UPDATE avatar SET is_default=0 WHERE tenant_id=?`).run(tenantId);
  db.prepare(`UPDATE avatar SET is_default=1 WHERE id=? AND tenant_id=?`).run(id, tenantId);
  return true;
});

/** 当前租户的默认形象(没有则 null)。**保持租户级**:is_default 是 tenant 单例,账号化会让多数创作者无默认。 */
export function getDefaultAvatar(tenantId: string): AvatarRow | null {
  return (db.prepare(`SELECT * FROM avatar WHERE tenant_id=? AND is_default=1`).get(tenantId) as AvatarRow) ?? null;
}

/** 列自定义形象。账号隔离:creator 仅自己建的;admin 全机构(含 NULL 老资产)。 */
export function listCustom(tenantId: string, actingUserId: string, isAdmin: boolean): AvatarRow[] {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db
    .prepare(`SELECT * FROM avatar WHERE tenant_id=?${scope.clause} ORDER BY created_at DESC`)
    .all(tenantId, ...scope.params) as AvatarRow[];
}

/** 取单个形象(账号隔离)。非本人非 admin → undefined → 路由 404。 */
export function getAvatar(id: string, tenantId: string, actingUserId: string, isAdmin: boolean): AvatarRow | undefined {
  const scope = scopeByActor(actingUserId, isAdmin);
  return db.prepare(`SELECT * FROM avatar WHERE id=? AND tenant_id=?${scope.clause}`).get(id, tenantId, ...scope.params) as
    | AvatarRow
    | undefined;
}

export function deleteAvatar(id: string, tenantId: string, actingUserId: string, isAdmin: boolean): boolean {
  const scope = scopeByActor(actingUserId, isAdmin);
  const res = db.prepare(`DELETE FROM avatar WHERE id=? AND tenant_id=?${scope.clause}`).run(id, tenantId, ...scope.params);
  return res.changes === 1;
}

/** 校验 avatarRef 是否可用于生成。预置形象全员可用;自定义形象**账号隔离**(用户定:自己的不共享):
 *  creator 仅认自己建的;admin 认本机构任意。 */
export function isUsableAvatar(avatarRef: string, tenantId: string, actingUserId: string, isAdmin: boolean): boolean {
  if (isPreset(avatarRef)) return true;
  const av = getAvatar(avatarRef, tenantId, actingUserId, isAdmin);
  return !!av && av.status === 'ready';
}
