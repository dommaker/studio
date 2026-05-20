/**
 * GEN-001 架构文档评审 - 演示版本
 * 
 * 展示会议状态，不创建真实数据库记录
 */

import { loadReviewRules, getRequiredParticipants } from '../src/core/review-rules-loader';

console.log('🏗️  GEN-001 Agent 系统架构设计文档评审\n');
console.log('=' .repeat(60));

// Spec 信息
const spec = {
  id: 'GEN-001',
  title: 'Agent 系统架构设计文档评审',
  changeType: 'architecture',
  impact: 'high',
  changes: [
    { id: 'GEN-001-C1', module: 'agent-system', desc: '确认四层架构模型' },
    { id: 'GEN-001-C2', module: 'agent-platform', desc: '创建 Monorepo' },
    { id: 'GEN-001-C3', module: 'harness', desc: '明确零业务逻辑边界' },
    { id: 'GEN-001-C4', module: 'agent-studio', desc: '明确业务层职责' },
    { id: 'GEN-001-C5', module: 'docs', desc: '定义接口契约规范' },
  ],
};

// 加载评审规则
const rules = loadReviewRules();

// 计算强制参与者
const requiredRoles = getRequiredParticipants(rules, spec.changeType, spec.impact);

// 模拟参与者
const participants = [
  { id: 'architect-1', role: 'architect', name: '架构师 A', status: 'pending' },
  { id: 'architect-2', role: 'architect', name: '架构师 B', status: 'pending' },
  { id: 'tech-lead-1', role: 'tech_lead', name: 'Tech Lead', status: 'pending' },
  { id: 'product-owner-1', role: 'product_owner', name: 'Product Owner', status: 'pending' },
  { id: 'cto', role: 'cto', name: 'CTO', status: 'optional' },
];

console.log('\n📋 Spec 信息');
console.log('-'.repeat(60));
console.log(`ID: ${spec.id}`);
console.log(`标题: ${spec.title}`);
console.log(`类型: ${spec.changeType}`);
console.log(`影响: ${spec.impact}`);

console.log('\n📝 变更清单');
console.log('-'.repeat(60));
spec.changes.forEach((c, i) => {
  console.log(`${i + 1}. [${c.module}] ${c.desc}`);
});

console.log('\n👥 参与者');
console.log('-'.repeat(60));
console.log('强制参与者 (根据 high impact + architecture):');
requiredRoles.forEach(role => {
  const p = participants.find(p => p.role === role);
  if (p) {
    console.log(`  ✅ ${p.name} (${role})`);
  }
});
console.log('\n可选参与者:');
participants.filter(p => p.status === 'optional').forEach(p => {
  console.log(`  ⭕ ${p.name} (${p.role})`);
});

console.log('\n📊 评审规则');
console.log('-'.repeat(60));
console.log(`通过标准: ${rules.approval.mode}`);
console.log(`最少批准: ${rules.approval.min_approvers} 人`);
console.log(`最大拒绝: ${rules.approval.max_rejecters} 人`);
console.log(`架构师批准: ${rules.approval.architect.required_approval ? '必需 ✅' : '非必需'}`);
console.log(`架构师否决: ${rules.approval.architect.can_veto ? '支持 ⚠️' : '不支持'}`);

console.log('\n⏰ 时限');
console.log('-'.repeat(60));
console.log(`每人响应: ${rules.timeout.per_person.duration}`);
console.log(`总时限: ${rules.timeout.total.duration}`);
console.log(`工作时间: ${rules.timeout.business_hours.work_hours[0]}:00-${rules.timeout.business_hours.work_hours[1]}:00`);
console.log(`工作日: 周一到周五`);

console.log('\n✅ 通过条件示例');
console.log('-'.repeat(60));
console.log('场景 1: 4 人参与，3 人 approve，架构师 approve');
console.log('  结果: ✅ 通过 (3/4 >= 2/3，有架构师批准)');
console.log('');
console.log('场景 2: 4 人参与，2 人 approve，2 人 abstain');
console.log('  结果: ❌ 不通过 (2/4 < 2/3)');
console.log('');
console.log('场景 3: 3 人参与，2 人 approve，架构师 reject');
console.log('  结果: ❌ 拒绝 (架构师否决权)');

console.log('\n🎯 评审重点');
console.log('-'.repeat(60));
console.log('1. 四层架构是否合理？');
console.log('2. Monorepo 是否必要？');
console.log('3. 工程边界是否清晰？');
console.log('4. 接口契约是否完整？');
console.log('5. 开源策略是否合适？');

console.log('\n📁 相关文档');
console.log('-'.repeat(60));
console.log('- docs/architecture/agent-system-architecture.md');
console.log('- docs/specs/GEN-001-architecture-review.md');

console.log('\n' + '='.repeat(60));
console.log('会议状态: 🟡 等待参与者响应');
console.log('下一步: 参与者登录系统投票 (approve/reject/abstain)');
console.log('='.repeat(60));
