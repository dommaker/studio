/**
 * P3: Multi-repo WorkUnit splitting
 *
 * When acGroups target different repos, split into separate groups.
 * Each group becomes an independent WorkUnit bound to its WorkspaceRepo.
 */

export interface AcGroupWithRepo {
  id: string;
  acs: string[];
  files: string[];
  dependencies: string[];
  targetRepo?: string;
  [key: string]: any;
}

export interface RepoGroup {
  targetRepo: string;
  acGroups: AcGroupWithRepo[];
}

/**
 * Split acGroups by targetRepo.
 *
 * Groups with the same targetRepo stay together.
 * Groups without targetRepo go to "__default__" group.
 */
export function splitAcGroupsByRepo(acGroups: AcGroupWithRepo[]): RepoGroup[] {
  const groupMap = new Map<string, AcGroupWithRepo[]>();

  for (const acGroup of acGroups) {
    const repo = acGroup.targetRepo || '__default__';
    const existing = groupMap.get(repo);
    if (existing) {
      existing.push(acGroup);
    } else {
      groupMap.set(repo, [acGroup]);
    }
  }

  return [...groupMap.entries()].map(([targetRepo, groups]) => ({
    targetRepo,
    acGroups: groups,
  }));
}
