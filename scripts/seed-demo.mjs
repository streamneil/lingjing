#!/usr/bin/env node
// 灵镜 — 一键种子:建演示机构 + 管理员 + 发放积分。
// 用法:DB_FILE=lingjing.db npx tsx scripts/seed-demo.mjs
// 用户名全局唯一,登录只需 用户名 + 密码(无需机构 ID)。

import { createTenant, createUser } from '../src/auth/index.ts';
import { grant } from '../src/credits/index.ts';
import { db } from '../src/db/index.ts';
import { seedPlatformDefaults } from '../src/seed/platform-defaults.ts';

// 幂等:逐个用户名独立判断(用户名全局唯一)。
// 之前只查 demoadmin 一个,若 demoadmin 不存在但 editor 已存在,会在建 editor 时撞唯一索引崩溃。
// 现在每个用户存在就跳过,租户也只在两个演示用户都不存在时才新建,避免重复同名租户。
// 注意:admin 是平台超管保留字(见 RESERVED_USERNAMES),演示租户管理员用 demoadmin。
const userExists = (u) => !!db.prepare('SELECT 1 FROM user WHERE username=?').get(u);

if (userExists('demoadmin') && userExists('editor')) {
  console.log('\n演示账号已存在,直接登录即可:demoadmin / pw123456(或 editor / pw123456)\n');
} else {
  // 复用已有演示用户所在的租户(若有);否则新建一个,避免重复同名"演示融媒体中心"。
  const existing = db.prepare('SELECT tenant_id FROM user WHERE username IN (?,?)').get('demoadmin', 'editor');
  const tenantId = existing ? existing.tenant_id : createTenant('演示融媒体中心', 'hosted').id;
  if (!userExists('demoadmin')) createUser(tenantId, 'demoadmin', 'pw123456', 'admin'); // admin 是保留字,管理员用 demoadmin
  if (!userExists('editor')) createUser(tenantId, 'editor', 'pw123456', 'creator');
  // 仅新租户发初始积分(已存在的租户不重复发)
  if (!existing) grant(tenantId, 5000);
  console.log('\n=== 灵镜演示账号已就绪 ===');
  console.log('机构管理员: demoadmin / pw123456');
  console.log('创作者    : editor / pw123456');
  console.log('初始积分  : 5000');
  console.log('(平台超管 admin 由 SUPERADMIN_PASS 环境变量首启自动创建,登录 /admin/login)');
}

// ── 平台默认数据(图片/视频模型 + 统一定价 model_pricing,含豆包/Gemini)──
// 单一真源:src/seed/platform-defaults.ts 的 seedPlatformDefaults()(app 启动也调它)。幂等。
{
  const r = seedPlatformDefaults();
  if (r.image || r.video || r.pricing)
    console.log(`平台默认数据已种子:图片模型 ${r.image}、视频档 ${r.video}、统一定价 ${r.pricing} 行(图片/视频/TTS/豆包/Gemini)`);
}

// 强制 WAL checkpoint:让写入立即落主库,避免另起的服务进程读到旧快照
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* noop */ }

console.log('登录: http://localhost:9372/login.html  (用户名 admin,密码 pw123456,无需机构 ID)\n');
