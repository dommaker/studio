// 需恢复的测试文件（已被 git 删除）
// 测试范围：GET /:provider 重定向 / GET /callback/:provider 回调
// Mock: oauthService, cookie, redirect
// 用例：授权重定向、state cookie 设置、回调处理、fragment redirect HTML、错误处理
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('OAuth Routes', () => {
  describe('GET /:provider', () => {
    it.todo('生成授权 URL 并 302 重定向到 provider');
    it.todo('设置 oauthState cookie（httpOnly, sameSite lax, 10min）');
    it.todo('不支持的 provider 返回错误');
  });

  describe('GET /callback/:provider', () => {
    it.todo('验证 code 并返回 fragment redirect HTML');
    it.todo('state 不匹配时拒绝回调');
    it.todo('provider 返回错误参数时处理');
    it.todo('使用 # 而非 ? 传递 token（防 Referer 泄漏）');
  });
});
