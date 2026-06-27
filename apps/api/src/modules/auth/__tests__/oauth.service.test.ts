// 需恢复的测试文件（已被 git 删除）
// 测试范围：getAuthorizationUrl / exchangeCodeForTokens / getOrCreateOAuthUser / createOAuthSession
// Mock: fetch provider API, prisma, generateToken/generateRefreshToken
// 用例：正常授权URL生成、code交换token、profile获取、upsert用户创建、并发安全、session创建、fragment redirect
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('OAuthService', () => {
  describe('getAuthorizationUrl', () => {
    it.todo('为 Google provider 生成正确授权 URL');
    it.todo('为 GitHub provider 生成正确授权 URL');
    it.todo('包含 state 参数和正确 redirect_uri');
    it.todo('不支持的 provider 抛出 OAuthError');
  });

  describe('exchangeCodeForTokens', () => {
    it.todo('用 code 成功交换 Google access token');
    it.todo('用 code 成功交换 GitHub access token');
    it.todo('获取 profile（email/name/avatar）');
    it.todo('provider 返回错误时抛出 OAuthError');
  });

  describe('getOrCreateOAuthUser', () => {
    it.todo('创建新用户 + OAuthAccount');
    it.todo('已有 OAuthAccount 时复现有用户');
    it.todo('同一邮箱但不同 provider 时创建新 OAuthAccount');
    it.todo('upsert 原子操作防止重复创建');
  });

  describe('createOAuthSession', () => {
    it.todo('创建 session 并返回 JWT + refreshToken');
  });
});
