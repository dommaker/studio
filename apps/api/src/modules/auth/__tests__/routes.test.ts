// 需恢复的测试文件（已被 git 删除）
// 测试范围：11 个 HTTP 端点集成测试
// Mock: authService, middleware
// 用例：所有端点的请求/响应验证、速率限制、错误处理、白名单
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Auth Routes', () => {
  describe('POST /guest-session', () => {
    it.todo('创建 guest session 并返回 token');
    it.todo('复用已存在的 guest session');
  });

  describe('POST /register', () => {
    it.todo('注册新用户成功');
    it.todo('重复邮箱返回错误');
    it.todo('密码强度不足返回验证错误');
    it.todo('受 authRateLimit 限制（10/min）');
  });

  describe('POST /login', () => {
    it.todo('正确凭据登录成功返回 JWT + refreshToken');
    it.todo('错误密码返回 401');
    it.todo('不存在邮箱返回 401（防枚举）');
    it.todo('受 authRateLimit 限制（10/min）');
  });

  describe('POST /logout', () => {
    it.todo('登出成功并使 session 过期');
  });

  describe('GET /me', () => {
    it.todo('返回当前用户信息');
    it.todo('未认证返回 200（无 user）');
  });

  describe('POST /refresh', () => {
    it.todo('有效 refreshToken 返回新 token 对');
    it.todo('已吊销 refreshToken 返回 401');
    it.todo('受 refreshRateLimit 限制（20/min）');
  });

  describe('POST /forgot-password', () => {
    it.todo('发送重置邮件');
    it.todo('不存在邮箱也返回成功（防枚举）');
  });

  describe('POST /reset-password', () => {
    it.todo('有效 token 重置密码成功');
    it.todo('无效/过期 token 返回错误');
  });

  describe('POST /send-verification', () => {
    it.todo('发送验证邮件');
  });

  describe('POST /verify-email', () => {
    it.todo('有效 token 验证邮箱成功');
    it.todo('无效/过期 token 返回错误');
  });

  describe('POST /cleanup', () => {
    it.todo('清理过期 session 成功');
  });
});
