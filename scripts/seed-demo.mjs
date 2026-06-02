#!/usr/bin/env node
// 灵镜 — 一键种子:建演示机构 + 管理员 + 发放积分。
// 用法:DB_FILE=lingjing.db npx tsx scripts/seed-demo.mjs
// 用户名全局唯一,登录只需 用户名 + 密码(无需机构 ID)。

import { createTenant, createUser } from '../src/auth/index.ts';
import { grant } from '../src/credits/index.ts';
import { db } from '../src/db/index.ts';

// 幂等:用户名全局唯一,已存在就不重复建(避免二次运行报"用户名已占用")
const exists = db.prepare('SELECT 1 FROM user WHERE username=?').get('admin');
if (exists) {
  console.log('\n演示账号已存在,直接登录即可:admin / pw123456(或 editor / pw123456)\n');
} else {
  const t = createTenant('演示融媒体中心', 'hosted');
  createUser(t.id, 'admin', 'pw123456', 'admin');
  createUser(t.id, 'editor', 'pw123456', 'creator');
  grant(t.id, 5000);
  console.log('\n=== 灵镜演示账号已就绪 ===');
  console.log('管理员   : admin / pw123456');
  console.log('创作者   : editor / pw123456');
  console.log('初始积分 : 5000');
}

// 强制 WAL checkpoint:让写入立即落主库,避免另起的服务进程读到旧快照
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* noop */ }

console.log('登录: http://localhost:9372/login.html  (用户名 admin,密码 pw123456,无需机构 ID)\n');
