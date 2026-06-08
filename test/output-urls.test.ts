// 灵镜 output_url 解析向后兼容测试 —— parseOutputKeys 纯函数,直接测真实代码。
//
// 覆盖 /plan-eng-review 测试覆盖图:output_url 读路径 JSON.parse + 兜底(向后兼容旧裸字符串)。

import { describe, it, expect } from 'vitest';

process.env.DB_FILE = ':memory:';

const { parseOutputKeys } = await import('../src/storage/index.js');

describe('parseOutputKeys 多图 / 向后兼容', () => {
  it('JSON key 数组 → 该数组', () => {
    expect(parseOutputKeys(JSON.stringify(['images/t/a.png', 'images/t/b.png']))).toEqual([
      'images/t/a.png',
      'images/t/b.png',
    ]);
  });

  it('旧视频裸 key 字符串(JSON.parse 失败)→ 当单 key', () => {
    expect(parseOutputKeys('videos/t/j.mp4')).toEqual(['videos/t/j.mp4']);
  });

  it('单元素数组 → 单 key', () => {
    expect(parseOutputKeys(JSON.stringify(['images/t/only.png']))).toEqual(['images/t/only.png']);
  });

  it('非数组 JSON(异常历史值)→ 当原字符串单 key 兜底', () => {
    // JSON.parse('"x"') 得字符串 'x'(非数组)→ 兜底用原始 outputUrl
    expect(parseOutputKeys('"weird"')).toEqual(['"weird"']);
  });
});
