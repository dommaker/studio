/**
 * RequirementsDoc — 会议 Decision[] → 结构化需求文档
 *
 * 会议产出 decisions 后，LLM 将原始决策聚合为结构化需求文档。
 * 每个 AcGroup 映射到一个并行 sub-agent。
 */

export interface RequirementsDoc {
  pmoNumber: string;
  summary: string;
  acGroups: AcGroup[];
  constraints: string[];
  generatedAt: string;
}

export interface AcGroup {
  /** 组标识 */
  id: string;
  /** 该组的验收标准 */
  acs: string[];
  /** 预期改动文件范围（用于冲突检测，重叠的组降级为串行） */
  files: string[];
  /** 依赖的其他 group id（空数组 = 无依赖，可并行） */
  dependencies: string[];
}

/**
 * 从 LLM 输出解析 RequirementsDoc
 */
export function parseRequirementsDoc(raw: string): RequirementsDoc | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.summary || !Array.isArray(parsed.acGroups)) return null;

    return {
      pmoNumber: parsed.pmoNumber || '',
      summary: parsed.summary,
      acGroups: parsed.acGroups.map((g: any) => ({
        id: g.id || `group-${Math.random().toString(36).slice(2, 8)}`,
        acs: Array.isArray(g.acs) ? g.acs : [],
        files: Array.isArray(g.files) ? g.files : [],
        dependencies: Array.isArray(g.dependencies) ? g.dependencies : [],
      })),
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
      generatedAt: parsed.generatedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * 构建 LLM prompt：将 decisions 聚合为 RequirementsDoc
 */
export function buildRequirementsDocPrompt(
  decisions: { content: string; agreed: boolean; priority: string }[],
  summary: string,
): string {
  const decisionText = decisions
    .map((d, i) => `${i + 1}. [${d.agreed ? '共识' : '待定'}] [${d.priority}] ${d.content}`)
    .join('\n');

  return `## 任务：将会议决策聚合为结构化需求文档

### 会议摘要
${summary}

### 决策列表
${decisionText}

请分析以上决策，输出 JSON 格式的需求文档：

\`\`\`json
{
  "summary": "一句话概述需求目标",
  "acGroups": [
    {
      "id": "group-a",
      "acs": ["AC-1: 具体验收标准", "AC-2: 具体验收标准"],
      "files": ["src/foo/bar.ts"],
      "dependencies": []
    }
  ],
  "constraints": ["技术约束1", "技术约束2"]
}
\`\`\`

规则：
1. 将相似的 AC 分组到同一个 acGroup（按功能模块或文件范围分组）
2. 每个 acGroup 的 files 列出预期改动的文件范围（只列 src/ 下的文件路径）
3. 如果 acGroup A 和 acGroup B 会改动同一个文件 → 在 dependencies 中标注依赖关系
4. constraints 列出会议中提到的技术约束`;
}

/**
 * 🆕 冲突修正：检测文件重叠 → 自动加依赖（SDD 模式）
 *
 * 两个 acGroup 有重叠文件但无依赖 → 自动加依赖使它们串行，
 * 避免并行修改同一文件导致 merge 冲突。
 * 在 RequirementsDoc LLM 聚合 + checker 之后调用。
 */
export function correctFileConflicts(acGroups: AcGroup[]): {
  corrected: AcGroup[];
  changes: { groupId: string; field: string; original: any; fixed: any; reason: string }[];
} {
  const corrected = acGroups.map(g => ({ ...g, files: [...g.files], dependencies: [...g.dependencies] }));
  const changes: { groupId: string; field: string; original: any; fixed: any; reason: string }[] = [];

  for (let i = 0; i < corrected.length; i++) {
    for (let j = i + 1; j < corrected.length; j++) {
      const a = corrected[i];
      const b = corrected[j];
      if (!a.files?.length || !b.files?.length) continue;

      const aFiles = new Set(a.files);
      const overlap = b.files.filter(f => aFiles.has(f));
      if (overlap.length === 0) continue;

      // 已有任意方向依赖 → 跳过
      if (a.dependencies.includes(b.id) || b.dependencies.includes(a.id)) continue;

      // B 依赖 A（A 先执行，B 串行在 A 之后）
      b.dependencies.push(a.id);
      changes.push({
        groupId: b.id,
        field: 'dependencies',
        original: [...b.dependencies].filter(d => d !== a.id),
        fixed: [...b.dependencies],
        reason: `文件重叠: ${overlap.join(', ')}（与 ${a.id} 冲突，自动串行）`,
      });
    }
  }

  return { corrected, changes };
}
