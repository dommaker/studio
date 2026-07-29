/**
 * Force git add + commit in the specified directory.
 * Does not depend on whether the agent committed — ensures changes are persisted.
 *
 * @param cwd Working directory (must be a git repository root)
 * @param message Commit message
 * @returns { success: true, commitHash } on success. commitHash is undefined when no changes.
 * @throws When the directory is not a git repository or git commands fail.
 */
export declare function forceCommit(cwd: string, message: string): {
    success: boolean;
    commitHash?: string;
};
//# sourceMappingURL=git-utils.d.ts.map