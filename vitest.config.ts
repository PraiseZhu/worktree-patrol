import { defineConfig } from 'vitest/config'

// 本仓只有 test/ 下的节点级测试;排除 node_modules 与临时 fixture 残留。
export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/_tmp/**'],
    // fixture 用例要建真实 git 仓 + 起子进程,给足超时
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
