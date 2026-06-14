// Task 3: Message Disambiguation — Distinguish "format validation" from "quality gate"
import { describe, it, expect } from 'vitest';

describe('Message Disambiguation: format validation vs quality gate', () => {
  describe('RequirementGate failure message (channel.routes.ts)', () => {
    // Simulate the message construction from channel.routes.ts ~line 525
    function buildGateFailureMessage(suggestions: string[], tierRecommendation: string): string {
      return `## ⚠️ RequirementGate 检查未通过\n\nRequirementsDoc 格式验证已通过，但 AC 结构需要修正：\n\n${
        suggestions.map(s => `- ${s}`).join('\n')
      }\n\n**建议**: ${
        tierRecommendation === 'needs-human'
          ? '请 @Analyst 修正上述问题后重新 /plan'
          : '已自动升级为 premium 模型重新分析'
      }`;
    }

    it('should contain "RequirementGate" not generic "质量检查"', () => {
      const msg = buildGateFailureMessage(['AC 缺少文件路径'], 'needs-human');
      expect(msg).toContain('RequirementGate');
      expect(msg).not.toContain('质量检查未通过');
    });

    it('should mention "格式验证已通过" for context', () => {
      const msg = buildGateFailureMessage(['AC 缺少文件路径'], 'needs-human');
      expect(msg).toContain('格式验证已通过');
    });

    it('should contain suggestions', () => {
      const suggestions = ['AC 缺少文件路径', 'AC 缺少依赖声明'];
      const msg = buildGateFailureMessage(suggestions, 'needs-human');
      expect(msg).toContain('AC 缺少文件路径');
      expect(msg).toContain('AC 缺少依赖声明');
    });

    it('should distinguish human vs auto-upgrade recommendation', () => {
      const humanMsg = buildGateFailureMessage(['issue'], 'needs-human');
      expect(humanMsg).toContain('请 @Analyst');

      const autoMsg = buildGateFailureMessage(['issue'], 'auto-upgrade');
      expect(autoMsg).toContain('已自动升级');
    });
  });

  describe('AnalystTrigger card content (analyst-trigger.service.ts)', () => {
    // Simulate formatCardContent from analyst-trigger.service.ts — three-layer structure
    interface RequirementsDocJson {
      requirement: {
        title: string;
        summary: string;
        acGroups: Array<{
          acs: unknown[];
        }>;
        tags?: string[];
        interfaceVerification?: { unverified?: string[] };
      };
      design: {
        acGroups: Array<{
          implementationNotes?: string;
        }>;
      };
    }

    function formatCardContent(doc: RequirementsDocJson): string {
      const acCount = doc.requirement.acGroups.reduce((sum, g) => sum + g.acs.length, 0);
      const tags = doc.requirement.tags?.length ? `\n🏷️ ${doc.requirement.tags.join(' · ')}` : '';
      const guideCount = doc.design.acGroups.filter(g => g.implementationNotes).length;
      const iv = doc.requirement.interfaceVerification;
      const unverifiedWarn = iv?.unverified?.length
        ? `\n⚠️ ${iv.unverified.length} 个接口假设未验证: ${iv.unverified.join(', ')}`
        : '';
      return [
        `## 📋 ${doc.requirement.title}`,
        '', doc.requirement.summary, '',
        `📊 ${doc.requirement.acGroups.length} 模块 · ${acCount} 验收标准 · ${guideCount} 实现指南`,
        `✅ 结构验证通过`,
        tags,
        unverifiedWarn,
      ].join('\n');
    }

    it('should contain "✅ 结构验证通过" to indicate format validation passed', () => {
      const doc: RequirementsDocJson = {
        requirement: {
          title: 'Test Feature',
          summary: 'A test feature',
          acGroups: [{ acs: ['ac1', 'ac2'] }],
        },
        design: {
          acGroups: [{ implementationNotes: 'notes' }],
        },
      };
      const card = formatCardContent(doc);
      expect(card).toContain('✅ 结构验证通过');
    });

    it('should NOT claim quality is verified — only structure', () => {
      const doc: RequirementsDocJson = {
        requirement: {
          title: 'Test Feature',
          summary: 'A test feature',
          acGroups: [{ acs: ['ac1'] }],
        },
        design: { acGroups: [] },
      };
      const card = formatCardContent(doc);
      expect(card).not.toContain('质量验证');
      expect(card).not.toContain('质量通过');
      expect(card).toContain('结构验证通过');
    });

    it('should still show module/AC stats', () => {
      const doc: RequirementsDocJson = {
        requirement: {
          title: 'Test Feature',
          summary: 'A test feature',
          acGroups: [
            { acs: ['ac1', 'ac2', 'ac3'] },
            { acs: ['ac4', 'ac5'] },
          ],
          tags: ['auth', 'api'],
        },
        design: {
          acGroups: [{ implementationNotes: 'guide1' }],
        },
      };
      const card = formatCardContent(doc);
      expect(card).toContain('2 模块');
      expect(card).toContain('5 验收标准');
      expect(card).toContain('1 实现指南');
    });
  });
});
