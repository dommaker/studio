import fs from 'node:fs';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, waitForReviewPassSettled } from '../../workunit-review.js';
import { registerWorkUnitPorts } from '../../workunit-ports.js';

const [, , mode, workUnitId] = process.argv;
const fileStore = new FileStore(process.env.STUDIO_DATA_DIR);
const markerFile = process.env.MERGE_MARKER_FILE;

registerWorkUnitPorts({
  verification: {
    isCodeWorktreeType: type => ['task', 'bug', 'feature', 'refactor'].includes(type),
    resolveCommands: async () => ({ commands: ['test'], source: 'convention' }),
    run: async () => {
      if (markerFile) fs.appendFileSync(markerFile, `${JSON.stringify({ type: 'start', pid: process.pid, at: Date.now() })}\n`);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (markerFile) fs.appendFileSync(markerFile, `${JSON.stringify({ type: 'end', pid: process.pid, at: Date.now() })}\n`);
      return { ran: ['test'] };
    },
  },
});

async function main(): Promise<void> {
  const service = new WorkUnitService(fileStore);
  if (mode === 'recover') {
    const { recoverWorktreeMerges } = await import('../../merge-on-review-pass.js');
    await recoverWorktreeMerges(service, fileStore);
    return;
  }
  if (!workUnitId) throw new Error('workUnitId required');
  if (mode.startsWith('crash-')) {
    const commitSnapshot = fileStore.commitSnapshot.bind(fileStore);
    fileStore.commitSnapshot = async (event, snapshot, options) => {
      const metadata = JSON.parse(snapshot.metadata ?? '{}');
      if (mode === 'crash-before-git' && metadata.mergeIntent?.state === 'running') process.exit(42);
      if (mode === 'crash-before-cleanup' && snapshot.status === 'done' && metadata.mergeReceipt?.verification?.status === 'passed') {
        const committed = await commitSnapshot(event, snapshot, options);
        process.exit(42);
        return committed;
      }
      if (metadata.mergeReceipt?.verification?.status === 'not-run') {
        if (mode === 'crash-before-receipt') process.exit(42);
        if (mode === 'crash-before-verify') {
          const committed = await commitSnapshot(event, snapshot, options);
          process.exit(42);
          return committed;
        }
      }
      return commitSnapshot(event, snapshot, options);
    };
  }
  await service.reviewPassed(workUnitId);
  await waitForReviewPassSettled();
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
