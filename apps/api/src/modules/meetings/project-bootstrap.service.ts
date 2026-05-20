/**
 * 项目引导服务 - 从会议创建项目
 * git init + 文件写入 + PMO 编号
 */
import { prisma, logger, publishMeetingEvent } from './meeting-shared.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export async function createProjectFromMeeting(
  meetingId: string,
  options: { title?: string; description?: string; requirement?: string; okrId?: string; priority?: string; gitRepo?: string }
) {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { companyId: true, status: true, summary: true, decisions: true, title: true, description: true },
  });

  if (!meeting) throw new Error('Meeting not found');

  // 获取默认 OKR
  let finalOkrId = options.okrId;
  if (!finalOkrId) {
    const { okrService } = await import('../pmo/okr.service');
    finalOkrId = await okrService.getDefaultOKR(meeting.companyId);
  }

  // 生成 PMO 号
  const latestProject = await prisma.project.findFirst({
    where: { companyId: meeting.companyId },
    orderBy: { createdAt: 'desc' },
  });

  let nextNumber = 1;
  if (latestProject) {
    const match = latestProject.pmoNumber.match(/PM-(\d+)/);
    if (match) nextNumber = parseInt(match[1]) + 1;
  }

  const pmoNumber = `PM-${nextNumber.toString().padStart(3, '0')}`;
  const gitBranch = `feat/${pmoNumber}`;

  const projectsBase = process.env.PROJECTS_DIR || path.join(os.homedir(), 'projects');
  const projectGitRepo = options.gitRepo || `${projectsBase}/${pmoNumber}`;

  if (!fs.existsSync(projectGitRepo)) {
    fs.mkdirSync(projectGitRepo, { recursive: true });
    logger.info(`[AS-017] Created gitRepo: ${projectGitRepo}`);
  }

  try {
    execSync(`cd ${projectGitRepo} && git init`, { encoding: 'utf-8' });
    execSync(`cd ${projectGitRepo} && git checkout -b ${gitBranch}`, { encoding: 'utf-8' });
    logger.info(`[AS-017] Initialized git with branch: ${gitBranch}`);
  } catch (gitError) {
    logger.info(`[AS-017] Git init warning: ${gitError}`);
  }

  // 写入会议输出文件
  const meetingOutputPath = path.join(projectGitRepo, 'meeting-output.md');
  const meetingOutputContent = `# 会议输出 - ${pmoNumber}

> 自动生成时间: ${new Date().toLocaleString('zh-CN')}

---

## 📋 会议纪要

${meeting.summary || '（暂无纪要）'}

---

## ✅ 决策

${meeting.decisions && Array.isArray(meeting.decisions)
    ? (meeting.decisions as Record<string, unknown>[]).map((d, i) => `${i + 1}. ${d.content || d}`).join('\n')
    : '（暂无决策）'}

---

## 📝 项目信息

| 字段 | 值 |
|------|------|
| PMO 号 | ${pmoNumber} |
| 标题 | ${options.title || meeting.title || '未命名'} |
| 优先级 | ${options.priority || 'normal'} |
| Git 分支 | ${gitBranch} |

---

*此文件由 Agent Studio 自动生成，请勿手动删除*
`;

  fs.writeFileSync(meetingOutputPath, meetingOutputContent, 'utf-8');

  try {
    execSync(`cd ${projectGitRepo} && git add .`, { encoding: 'utf-8' });
    execSync(`cd ${projectGitRepo} && git commit -m "init: meeting output from ${pmoNumber}"`, { encoding: 'utf-8' });
    logger.info(`[AS-017] Initial commit created`);
  } catch (commitError) {
    logger.info(`[AS-017] Initial commit warning: ${commitError}`);
  }

  const project = await prisma.project.create({
    data: {
      pmoNumber,
      title: options.title || meeting.title,
      description: options.description || meeting.description,
      requirement: options.requirement,
      companyId: meeting.companyId,
      okrId: finalOkrId,
      priority: options.priority || 'normal',
      status: 'active',
      startedAt: new Date(),
      gitRepo: projectGitRepo,
      gitBranch,
    },
  });

  const updatedMeeting = await prisma.meeting.update({
    where: { id: meetingId },
    data: { outputProjectId: project.id },
    include: { OutputProject: true },
  });

  await publishMeetingEvent('meeting.project_created', meetingId, {
    pmoNumber,
    projectId: project.id,
  });

  return { meeting: updatedMeeting, project };
}
