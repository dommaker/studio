/**
 * local/no-deep-module-import — 模块边界规则（P2-c 立界，docs/architecture/target-architecture.md）
 *
 * 硬规则：跨模块只允许 import 对方模块根 index.ts 的公共面。
 * modules/X/** 深路径被 modules/Y/**（Y≠X）或 apps/api/src 其他位置 import → error。
 *
 * 覆盖：静态 import / export-from / 动态 import() / require()。
 * 白名单（测试、route-registry 等基础设施）在 eslint.config.mjs 以 files 块关闭本规则实现。
 */
import path from 'node:path';

const SRC_ROOT = 'apps/api/src';

/**
 * 判定一次 import 是否越界。
 * 返回 null（合法）或 { module, deepPath }（违规）。
 */
export function findDeepModuleImport(filename, specifier, srcRoot = SRC_ROOT) {
  if (!specifier || !specifier.startsWith('.')) return null;
  const modulesRoot = path.join(srcRoot, 'modules');
  const resolved = path.normalize(path.join(path.dirname(filename), specifier));
  const rel = path.relative(modulesRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segs = rel.split(path.sep);
  const mod = segs[0];
  // 消费方自身模块：内部深引用合法
  const consRel = path.relative(modulesRoot, filename);
  const consMod = consRel.startsWith('..') ? null : consRel.split(path.sep)[0];
  if (consMod === mod) return null;
  const rest = segs.slice(1).join('/');
  if (!rest || /^index\.(ts|tsx|js|mts|cts)$/.test(rest)) return null; // 模块根 barrel，合法
  return { module: mod, deepPath: rest };
}

export default {
  meta: {
    type: 'problem',
    docs: { description: '跨模块只允许 import 对方模块根 index.ts 公共面（P2-c 模块边界）' },
    schema: [],
    messages: {
      deepImport:
        '禁止跨模块深路径 import "{{ specifier }}"：请改从模块根公共面 import（apps/api/src/modules/{{ module }}/index.ts）。公共面缺符号时在对方 index.ts 补导出。',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    function check(node, specifier) {
      const hit = findDeepModuleImport(filename, specifier);
      if (hit) context.report({ node, messageId: 'deepImport', data: { specifier, module: hit.module } });
    }
    return {
      ImportDeclaration(node) { check(node, node.source.value); },
      ExportNamedDeclaration(node) { if (node.source) check(node, node.source.value); },
      ExportAllDeclaration(node) { check(node, node.source.value); },
      ImportExpression(node) { if (node.source.type === 'Literal') check(node, node.source.value); },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require'
          && node.arguments.length === 1 && node.arguments[0].type === 'Literal') {
          check(node, node.arguments[0].value);
        }
      },
    };
  },
};
