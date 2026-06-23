/**
 * dependsOn 环检测 — 拓扑排序
 *
 * AS-025 Phase 2: 创建/更新 WorkUnit 时校验 dependsOn 不形成环。
 * 算法：DFS 拓扑排序，O(V+E)。
 */

/**
 * 检测 dependsOn 是否形成环。
 *
 * @param edges - 有向边集合 Map<nodeId, dependsOnIds[]>
 * @returns true if cycle exists, false otherwise
 */
export function hasCycle(edges: Map<string, string[]>): boolean {
  const WHITE = 0; // unvisited
  const GRAY = 1;  // visiting (in current DFS path)
  const BLACK = 2; // visited (fully explored)

  const color = new Map<string, number>();
  for (const node of edges.keys()) {
    color.set(node, WHITE);
  }
  // Also add target nodes that might not be keys
  for (const deps of edges.values()) {
    for (const dep of deps) {
      if (!color.has(dep)) color.set(dep, WHITE);
    }
  }

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    const deps = edges.get(node) ?? [];
    for (const dep of deps) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) return true;  // back edge → cycle
      if (c === WHITE && dfs(dep)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const node of color.keys()) {
    if (color.get(node) === WHITE) {
      if (dfs(node)) return true;
    }
  }
  return false;
}

/**
 * 校验新增/修改的 dependsOn 是否引入环。
 *
 * @param newId - 正在创建/更新的 WorkUnit ID
 * @param newDependsOn - 新的 dependsOn 列表
 * @param existingEdges - 已有 WorkUnit 的 dependsOn 关系（不含 newId 的出边）
 * @throws Error if cycle detected
 */
export function validateNoCycle(
  newId: string,
  newDependsOn: string[],
  existingEdges: Map<string, string[]>,
): void {
  // 构建包含新边的完整图
  const edges = new Map(existingEdges);
  edges.set(newId, newDependsOn);

  if (hasCycle(edges)) {
    throw new Error(
      `Cycle detected in dependsOn: adding ${newId} → [${newDependsOn.join(', ')}] would create a dependency cycle`
    );
  }
}
