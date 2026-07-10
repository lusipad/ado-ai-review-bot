import { defineConfig } from 'vitest/config';

// data/ 是运行时状态目录（mirror、worktree、codex-home），里面可能出现第三方测试文件
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
