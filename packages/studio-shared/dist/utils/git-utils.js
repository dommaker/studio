/**
 * Git utility functions extracted from Pipeline executor-subagent-spawner.
 *
 * Provides forceCommit: force git add + commit in a specified directory.
 */
import { execSync } from 'child_process';
import { realpathSync } from 'fs';
/**
 * Force git add + commit in the specified directory.
 * Does not depend on whether the agent committed — ensures changes are persisted.
 *
 * @param cwd Working directory (must be a git repository root)
 * @param message Commit message
 * @returns { success: true, commitHash } on success. commitHash is undefined when no changes.
 * @throws When the directory is not a git repository or git commands fail.
 */
export function forceCommit(cwd, message) {
    // Verify cwd is a git repository root (not a subdirectory of one)
    const gitRoot = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8' }).trim();
    if (realpathSync(gitRoot) !== realpathSync(cwd)) {
        throw new Error(`Not a git repository root: ${cwd}`);
    }
    // Check if there are changes
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8' });
    if (!status.trim()) {
        return { success: true, commitHash: undefined };
    }
    execSync('git add -A', { cwd, encoding: 'utf-8' });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd,
        encoding: 'utf-8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Studio',
            GIT_AUTHOR_EMAIL: 'studio@local',
            GIT_COMMITTER_NAME: 'Studio',
            GIT_COMMITTER_EMAIL: 'studio@local',
        },
    });
    const hash = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();
    return { success: true, commitHash: hash };
}
//# sourceMappingURL=git-utils.js.map