/**
 * migrate-spec3-to-files.ts — 从 SQLite 导出 Spec 3 的 7 个表到 FileStore
 *
 * Usage:
 *   npx tsx scripts/migrate-spec3-to-files.ts [--dry-run]
 *
 * Tables migrated:
 *   Project → ~/.studio/projects/{id}.json
 *   Task → ~/.studio/projects/{projectId}/tasks.jsonl
 *   Document → 跳过（内容已在文件系统中）
 *   SpecReview → ~/.studio/spec-reviews/{id}.json
 *   SpecReviewApproval → 嵌入 SpecReview JSON
 *   SpecBypass → 跳过（单人部署不需要）
 *   SpecVersion → 跳过（CHANGELOG.md 替代）
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const prisma = new PrismaClient();
const STUDIO_DIR = path.join(os.homedir(), '.studio');
const DRY_RUN = process.argv.includes('--dry-run');

const PATHS = {
  projects: path.join(STUDIO_DIR, 'projects'),
  specReviews: path.join(STUDIO_DIR, 'spec-reviews'),
} as const;

function ensureDir(dir: string) {
  if (!DRY_RUN) fs.mkdirSync(dir, { recursive: true });
}

function log(msg: string) {
  console.log(`[${DRY_RUN ? 'DRY-RUN' : 'MIGRATE'}] ${msg}`);
}

// ─── Project → ~/.studio/projects/{id}.json ───

async function migrateProjects(): Promise<number> {
  ensureDir(PATHS.projects);
  const projects = await (prisma as any).project.findMany();
  let count = 0;

  for (const p of projects) {
    const filePath = path.join(PATHS.projects, `${p.id}.json`);
    if (fs.existsSync(filePath)) {
      log(`Project ${p.id} already exists — skipping`);
      continue;
    }
    const record = {
      id: p.id,
      pmoNumber: p.pmoNumber,
      title: p.title,
      description: p.description,
      requirement: p.requirement,
      companyId: p.companyId,
      okrId: null,
      status: p.status,
      priority: p.priority,
      progress: p.progress,
      gitBranch: p.gitBranch,
      gitRepo: p.gitRepo,
      specFilePath: p.specFilePath,
      requirementsDocId: p.requirementsDocId,
      startedAt: p.startedAt?.toISOString?.() ?? null,
      completedAt: p.completedAt?.toISOString?.() ?? null,
      createdAt: p.createdAt?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: p.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    };
    if (!DRY_RUN) fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    count++;
  }
  return count;
}

// ─── Task → ~/.studio/projects/{projectId}/tasks.jsonl ───

async function migrateTasks(): Promise<number> {
  const tasks = await (prisma as any).task.findMany();
  const byProject = new Map<string, any[]>();
  for (const t of tasks) {
    if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
    byProject.get(t.projectId)!.push(t);
  }
  let count = 0;

  for (const [projectId, projectTasks] of byProject) {
    const dir = path.join(PATHS.projects, projectId);
    ensureDir(dir);
    const filePath = path.join(dir, 'tasks.jsonl');
    if (fs.existsSync(filePath)) {
      log(`Tasks for ${projectId} already exist — skipping`);
      continue;
    }
    const lines = projectTasks.map(t => JSON.stringify({
      id: t.id,
      projectId: t.projectId,
      name: t.name,
      description: t.description,
      assignee: t.assignee,
      priority: t.priority,
      status: t.status,
      claimedBy: t.claimedBy,
      claimedAt: t.claimedAt?.toISOString?.() ?? null,
      dependsOn: JSON.parse(t.dependsOn || '[]'),
      acceptanceCriteria: JSON.parse(t.acceptanceCriteria || '[]'),
      estimatedHours: t.estimatedHours,
      startedAt: t.startedAt?.toISOString?.() ?? null,
      completedAt: t.completedAt?.toISOString?.() ?? null,
      testEvidence: t.testEvidence,
      createdAt: t.createdAt?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: t.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    }));
    if (!DRY_RUN) fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    count += projectTasks.length;
  }
  return count;
}

// ─── SpecReview → ~/.studio/spec-reviews/{id}.json ───

async function migrateSpecReviews(): Promise<number> {
  ensureDir(PATHS.specReviews);
  const reviews = await (prisma as any).specReview.findMany({
    include: { SpecReviewApproval: true },
  });
  let count = 0;

  for (const r of reviews) {
    const filePath = path.join(PATHS.specReviews, `${r.id}.json`);
    if (fs.existsSync(filePath)) {
      log(`SpecReview ${r.id} already exists — skipping`);
      continue;
    }
    let approvals = {};
    try { approvals = JSON.parse(r.approvals || '{}'); } catch { /* legacy format */ }
    const record = {
      id: r.id,
      title: r.title,
      description: r.description,
      changes: JSON.parse(r.changes || '[]'),
      changeType: r.changeType,
      impact: r.impact,
      status: r.status,
      requestedBy: r.requestedBy,
      reviewedAt: r.reviewedAt?.toISOString?.() ?? null,
      reviewedBy: r.reviewedBy,
      comment: r.comment,
      approvals,
      specReviewApprovals: (r.SpecReviewApproval || []).map((a: any) => ({
        id: a.id,
        reviewId: a.reviewId,
        role: a.role,
        reviewerId: a.reviewerId,
        reviewerName: a.reviewerName,
        approved: a.approved,
        comment: a.comment,
        createdAt: a.createdAt?.toISOString?.() ?? new Date().toISOString(),
      })),
      createdAt: r.createdAt?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: r.updatedAt?.toISOString?.() ?? new Date().toISOString(),
    };
    if (!DRY_RUN) fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
    count++;
  }
  return count;
}

// ─── Main ───

async function main() {
  console.log(`Spec 3 Migration ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(50));

  log('Exporting Projects...');
  const projectCount = await migrateProjects();
  log(`  → ${projectCount} projects exported`);

  log('Exporting Tasks...');
  const taskCount = await migrateTasks();
  log(`  → ${taskCount} tasks exported`);

  log('Skipping Document (content already in filesystem)');

  log('Exporting SpecReviews...');
  const reviewCount = await migrateSpecReviews();
  log(`  → ${reviewCount} reviews exported`);

  log('Skipping SpecBypass + SpecVersion (not needed for single-user deployment)');

  console.log('='.repeat(50));
  console.log(`Done. ${projectCount} projects, ${taskCount} tasks, ${reviewCount} reviews.`);

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] No files written. Run without --dry-run to execute.');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
