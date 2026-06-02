#!/usr/bin/env node
// 灵镜 — 一键种子:建演示机构 + 管理员 + 发放积分。
// 用法:DB_FILE=lingjing.db node scripts/seed-demo.mjs
// 输出登录信息(机构ID / 用户名 / 密码),直接拿去 login.html 登录。

import { createTenant, createUser } from '../src/auth/index.ts';
import { grant } from '../src/credits/index.ts';

const t = createTenant('演示融媒体中心', 'hosted');
createUser(t.id, 'admin', 'pw123456', 'admin');
createUser(t.id, 'editor', 'pw123456', 'creator');
grant(t.id, 5000);

console.log('\n=== 灵镜演示账号已就绪 ===');
console.log('机构 ID :', t.id);
console.log('管理员   : admin / pw123456');
console.log('创作者   : editor / pw123456');
console.log('初始积分 : 5000');
console.log('\n登录: http://localhost:3000/login.html');
console.log('(机构 ID 复制上面那串,用户名 admin,密码 pw123456)\n');
