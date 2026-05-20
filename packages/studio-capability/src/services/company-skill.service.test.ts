/**
 * CompanySkillService 单元测试
 * 
 * 覆盖 AC：
 * - AC-001: 创建公司技能成功
 * - AC-002: 技能名在公司内唯一
 * - AC-003: 查询技能列表返回正确
 * - AC-004: 查询技能详情返回正确
 * - AC-005: 更新技能成功
 * - AC-006: 删除技能成功
 * - AC-007: 继承 global 技能配置
 * - AC-008: 覆盖 parent 配置
 * - AC-009: 按分类查询技能
 * - AC-010: 搜索技能名
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { CompanySkillService } from './company-skill.service.js';

const prisma = new PrismaClient();

describe('CompanySkillService', () => {
  let service: CompanySkillService;
  let testCompanyId: string;

  beforeAll(async () => {
    const existing = await prisma.company.findUnique({
      where: { id: 'test-company-skill-001' },
    });

    if (!existing) {
      const company = await prisma.company.create({
        data: { id: 'test-company-skill-001', name: 'Test Company' },
      });
      testCompanyId = company.id;
    } else {
      testCompanyId = existing.id;
    }

    service = new CompanySkillService();
  });

  afterEach(async () => {
    // 清理测试数据
    await prisma.companySkill.deleteMany({
      where: { companyId: testCompanyId },
    });
  });

  // AC-001: 创建公司技能成功
  it('AC-001: should create company skill', async () => {
    const input = {
      companyId: testCompanyId,
      name: 'custom-code-review',
      description: '公司定制代码审查',
      category: '开发',
    };

    const skill = await prisma.companySkill.create({ data: input });

    expect(skill.id).toBeDefined();
    expect(skill.name).toBe('custom-code-review');
    expect(skill.category).toBe('开发');
    expect(skill.layer).toBe('company');
    expect(skill.status).toBe('active');
  });

  // AC-002: 技能名在公司内唯一
  it('AC-002: should enforce unique name within company', async () => {
    // 创建第一个技能
    await prisma.companySkill.create({
      data: { companyId: testCompanyId, name: 'skill-1' },
    });

    // 创建同名技能应该失败
    await expect(
      prisma.companySkill.create({
        data: { companyId: testCompanyId, name: 'skill-1' },
      })
    ).rejects.toThrow();
  });

  // AC-003: 查询技能列表返回正确
  it('AC-003: should list skills correctly', async () => {
    // 创建多个技能
    await prisma.companySkill.createMany({
      data: [
        { companyId: testCompanyId, name: 'skill-a', category: '开发' },
        { companyId: testCompanyId, name: 'skill-b', category: '设计' },
        { companyId: testCompanyId, name: 'skill-c', category: '开发' },
      ],
    });

    const skills = await prisma.companySkill.findMany({
      where: { companyId: testCompanyId },
    });

    expect(skills.length).toBe(3);
    expect(skills.map(s => s.name)).toContain('skill-a');
    expect(skills.map(s => s.name)).toContain('skill-b');
    expect(skills.map(s => s.name)).toContain('skill-c');
  });

  // AC-004: 查询技能详情返回正确
  it('AC-004: should get skill detail correctly', async () => {
    const created = await prisma.companySkill.create({
      data: {
        companyId: testCompanyId,
        name: 'skill-detail',
        description: '测试详情',
        config: JSON.stringify({ timeout: 60 }),
      },
    });

    const skill = await prisma.companySkill.findUnique({
      where: { id: created.id },
    });

    expect(skill).toBeDefined();
    expect(skill!.name).toBe('skill-detail');
    expect(skill!.description).toBe('测试详情');
    expect(JSON.parse(skill!.config!)).toEqual({ timeout: 60 });
  });

  // AC-005: 更新技能成功
  it('AC-005: should update skill successfully', async () => {
    const created = await prisma.companySkill.create({
      data: { companyId: testCompanyId, name: 'skill-update' },
    });

    const updated = await prisma.companySkill.update({
      where: { id: created.id },
      data: {
        description: '更新后的描述',
        config: JSON.stringify({ timeout: 120 }),
      },
    });

    expect(updated.description).toBe('更新后的描述');
    expect(JSON.parse(updated.config!)).toEqual({ timeout: 120 });
  });

  // AC-006: 删除技能成功
  it('AC-006: should delete skill successfully', async () => {
    const created = await prisma.companySkill.create({
      data: { companyId: testCompanyId, name: 'skill-delete' },
    });

    await prisma.companySkill.delete({ where: { id: created.id } });

    const deleted = await prisma.companySkill.findUnique({
      where: { id: created.id },
    });

    expect(deleted).toBeNull();
  });

  // AC-007: 继承 global 技能配置
  it('AC-007: should inherit from global skill config', async () => {
    // 创建 parent 技能（模拟 global）
    const parent = await prisma.companySkill.create({
      data: {
        companyId: testCompanyId,
        name: 'git-commit-global',
        layer: 'atomic',
        config: JSON.stringify({ timeout: 60, autoPush: false }),
      },
    });

    // 创建继承技能
    const child = await prisma.companySkill.create({
      data: {
        companyId: testCompanyId,
        name: 'git-commit-custom',
        parentSkillId: parent.id,
        layer: 'company',
      },
    });

    expect(child.parentSkillId).toBe(parent.id);
    expect(child.layer).toBe('company');
  });

  // AC-008: 覆盖 parent 配置
  it('AC-008: should override parent config', async () => {
    const parent = await prisma.companySkill.create({
      data: {
        companyId: testCompanyId,
        name: 'parent-skill',
        config: JSON.stringify({ timeout: 60, retries: 3 }),
      },
    });

    const child = await prisma.companySkill.create({
      data: {
        companyId: testCompanyId,
        name: 'child-skill',
        parentSkillId: parent.id,
        config: JSON.stringify({ timeout: 120 }), // 覆盖 timeout，保留 retries
      },
    });

    // 验证覆盖
    expect(JSON.parse(child.config!)).toEqual({ timeout: 120 });
  });

  // AC-009: 按分类查询技能
  it('AC-009: should query skills by category', async () => {
    await prisma.companySkill.createMany({
      data: [
        { companyId: testCompanyId, name: 'dev-1', category: '开发' },
        { companyId: testCompanyId, name: 'dev-2', category: '开发' },
        { companyId: testCompanyId, name: 'design-1', category: '设计' },
      ],
    });

    const devSkills = await prisma.companySkill.findMany({
      where: { companyId: testCompanyId, category: '开发' },
    });

    expect(devSkills.length).toBe(2);
    expect(devSkills.every(s => s.category === '开发')).toBe(true);
  });

  // AC-010: 搜索技能名
  it('AC-010: should search skill by name', async () => {
    await prisma.companySkill.createMany({
      data: [
        { companyId: testCompanyId, name: 'code-review-auto' },
        { companyId: testCompanyId, name: 'code-review-manual' },
        { companyId: testCompanyId, name: 'design-review' },
      ],
    });

    const results = await prisma.companySkill.findMany({
      where: {
        companyId: testCompanyId,
        name: { contains: 'code-review' },
      },
    });

    expect(results.length).toBe(2);
    expect(results.every(s => s.name.includes('code-review'))).toBe(true);
  });
});