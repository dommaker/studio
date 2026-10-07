import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// 测试环境端口（通过环境变量 VITE_DEV_API_PORT 控制）
const DEV_API_PORT = parseInt(process.env.VITE_DEV_API_PORT || '13001'); // 默认开发环境端口

// dev server 与 vite preview 共用的反代表（#674：preview 供 LCP 测量以构建产物形态起服）
const apiProxy = {
  '/api': {
    target: `http://localhost:${DEV_API_PORT}`,
    changeOrigin: true,
  },
  '/ws': {
    target: `http://localhost:${DEV_API_PORT}`,
    changeOrigin: true,
    ws: true,  // WebSocket 代理
  },
  '/health': {
    target: `http://localhost:${DEV_API_PORT}`,
    changeOrigin: true,
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  css: {
    postcss: './postcss.config.js',
  },
  server: {
    host: '0.0.0.0', // 允许外网访问
    port: parseInt(process.env.VITE_PORT || '5173'),
    allowedHosts: true, // 允许所有 hosts 访问（Tailscale 网络内安全）
    hmr: {
      // 客户端端口（服务器实际监听端口）
      // host 不设置，让客户端自动使用访问地址
      port: parseInt(process.env.VITE_PORT || '5173'),
    },
    proxy: apiProxy,
  },
  // #674：LCP 测量（scripts/perf/lcp.ts）以构建产物形态起服，反代表与 dev 同源
  preview: {
    host: '127.0.0.1',
    port: parseInt(process.env.VITE_PREVIEW_PORT || '4173'),
    proxy: apiProxy,
  },
  build: {
    rollupOptions: {
      output: {
        // PF-005: 代码分割优化
        manualChunks(id) {
          // React 核心库单独打包
          if (id.includes('react/') || id.includes('react-dom/')) {
            return 'vendor-react';
          }
          // React 生态库（router 等）
          if (id.includes('react-router')) {
            return 'vendor-react-eco';
          }
          // 流程图库（大型，按需加载）
          if (id.includes('@xyflow') || id.includes('xyflow')) {
            return 'vendor-xyflow';
          }
          // 状态管理（独立缓存，变更频率低）
          if (id.includes('zustand')) {
            return 'vendor-state';
          }
          // HTTP 客户端（独立缓存）
          if (id.includes('axios')) {
            return 'vendor-http';
          }
          // 其他第三方库
          if (id.includes('node_modules')) {
            return 'vendor-utils';
          }
        },
      },
    },
    // 调整 chunk 大小警告阈值
    chunkSizeWarningLimit: 400,
  },
})
