#!/usr/bin/env tsx
/**
 * meeting.ended 流程测试
 *
 * 测试流程：
 * 1. 创建测试会议
 * 2. 发布 meeting.ended 事件
 * 3. 验证风险评估和 Discord 通知
 * 4. 模拟确认按钮点击
 * 5. 验证执行继续
 */

import { PrismaClient } from '@dommaker/studio-prisma';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

async function main() {
  console.log('=== meeting.ended 流程测试 ===\n');

  // 1. 创建测试会议
  console.log('1. 创建测试会议...');
  const meeting = await prisma.meeting.create({
    data: {
      title: '测试高风险会议',
      status: 'discussing',
      discussionStatus: 'pending',
      discussionType: 'spec_review',
      projectId: 'test-project-id',
      initiatorRole: 'test-role',
      participantRoles: ['PM', 'DEV', 'QA'],
      decisions: JSON.stringify([
        { content: '删除旧数据库表', stance: 'agree', role: 'DEV' },
        { content: '新增迁移脚本', stance: 'agree', role: 'DEV' },
        { content: '修改权限配置', stance: 'disagree', role: 'QA' }
      ])
    }
  });
  console.log(`   会议创建成功: ${meeting.id}\n`);

  // 2. 模拟 meeting.ended 事件
  console.log('2. 发布 meeting.ended 事件...');
  const event = {
    event_type: 'meeting.ended',
    data: {
      meetingId: meeting.id,
      projectId: 'test-project-id',
      decisionsKey: `meeting:${meeting.id}:decisions`,
      decisionCount: 3
    }
  };

  await redis.publish('events:meeting', JSON.stringify(event));
  console.log('   事件已发布\n');

  // 3. 等待处理并检查结果
  console.log('3. 等待风险评估处理（5秒）...');
  await new Promise(r => setTimeout(r, 5000));

  const updatedMeeting = await prisma.meeting.findUnique({
    where: { id: meeting.id }
  });

  console.log('   会议状态:', updatedMeeting?.status);
  console.log('   讨论状态:', updatedMeeting?.discussionStatus);

  if (updatedMeeting?.riskAssessment) {
    const risk = JSON.parse(updatedMeeting.riskAssessment as string);
    console.log('   风险等级:', risk.level);
    console.log('   风险评分:', risk.score);
    console.log('   风险原因:', risk.reasons);
  }

  // 4. 检查是否发送了 Discord 通知
  console.log('\n4. 检查 Discord 通知日志...');
  console.log('   （请查看 PM2 日志确认 Discord 消息发送）');
  console.log('   命令: pm2 logs agent-studio-api --lines 20');

  // 5. 模拟确认按钮点击（通过 Discord interaction 端点）
  console.log('\n5. 模拟确认按钮点击...');
  const confirmResponse = await fetch('http://localhost:13101/api/v1/discord/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 3,  // MESSAGE_COMPONENT
      data: {
        component_type: 2,
        custom_id: `confirm:${meeting.id}`
      }
    })
  });

  if (confirmResponse.ok) {
    console.log('   确认请求发送成功');
  } else {
    console.log('   确认请求失败:', confirmResponse.status);
  }

  // 6. 等待处理并验证最终状态
  console.log('\n6. 等待确认处理（3秒）...');
  await new Promise(r => setTimeout(r, 3000));

  const finalMeeting = await prisma.meeting.findUnique({
    where: { id: meeting.id }
  });

  console.log('   最终状态:', finalMeeting?.status);
  console.log('   最终讨论状态:', finalMeeting?.discussionStatus);

  // 7. 清理测试数据
  console.log('\n7. 清理测试数据...');
  await prisma.meeting.delete({ where: { id: meeting.id } });
  console.log('   测试会议已删除');

  // 8. 总结
  console.log('\n=== 测试完成 ===');
  console.log('流程验证：');
  console.log('  [✓] 创建会议');
  console.log('  [✓] 发布 meeting.ended 事件');
  console.log(`  [${updatedMeeting?.riskAssessment ? '✓' : '✗'}] 风险评估执行`);
  console.log(`  [${updatedMeeting?.discussionStatus === 'pending_confirmation' || updatedMeeting?.discussionStatus === 'confirmed' ? '✓' : '✗'}] Discord 通知发送`);
  console.log(`  [${finalMeeting?.discussionStatus === 'confirmed' ? '✓' : '✗'}] 确认后继续执行`);

  await prisma.$disconnect();
  await redis.quit();
}

main().catch(console.error);