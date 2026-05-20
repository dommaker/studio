// 直接测试 DiscussionDriver
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';

const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const MEETING_ID = 'cmobfn7n5000m149yx0qqn4r2';

async function test() {
  console.log('=== 测试 DiscussionDriver ===');
  
  // 1. 检查会议状态
  const meeting = await prisma.meeting.findUnique({
    where: { id: MEETING_ID },
    include: {
      MeetingParticipant: { include: { Role: true } },
      MeetingMessage: { orderBy: { createdAt: 'asc' } },
    },
  });
  
  console.log('会议信息:');
  console.log('  - status:', meeting?.status);
  console.log('  - discussionStatus:', meeting?.discussionStatus);
  console.log('  - 参与者:', meeting?.MeetingParticipant?.map(p => p.Role?.name));
  console.log('  - 消息数:', meeting?.MeetingMessage?.length);
  
  if (!meeting || meeting.status !== 'discussing') {
    console.log('会议状态不正确，退出');
    return;
  }
  
  // 2. 检查 Redis 任务状态
  const taskId = '9b981a2d-5203-4a80-9c85-61132b75e46a';
  const taskData = await redis.get(`discussion:task:${taskId}`);
  console.log('Redis 任务:', taskData);
  
  // 3. 测试 LLM API
  console.log('\n测试 LLM API...');
  const llmRes = await fetch('http://localhost:13101/api/v1/llm/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: '你好，请简短回复' }],
      temperature: 0.7,
    }),
  });
  
  const llmData = await llmRes.json() as { content?: string; choices?: Array<{ message?: { content?: string } }> };
  console.log('LLM 响应:', llmData.content || llmData.choices?.[0]?.message?.content?.slice(0, 100));
  
  // 4. 手动创建一条测试消息
  console.log('\n手动创建测试消息...');
  const participant = meeting.MeetingParticipant?.[0];
  if (participant) {
    const msg = await prisma.meetingMessage.create({
      data: {
        meetingId: MEETING_ID,
        participantId: participant.id,
        roleId: participant.roleId,
        content: '这是一条测试消息，由脚本直接创建',
        messageType: 'speech',
        stance: participant.stance,
        round: 1,
      },
    });
    console.log('创建成功:', msg.id);
  }
  
  // 5. 再次检查消息数
  const meeting2 = await prisma.meeting.findUnique({
    where: { id: MEETING_ID },
    include: { MeetingMessage: true },
  });
  console.log('\n更新后的消息数:', meeting2?.MeetingMessage?.length);
  
  await prisma.$disconnect();
  await redis.quit();
}

test().catch(console.error);