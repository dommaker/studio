/**
 * local/no-hand-copied-api-types — web api 层手抄类型防回潮（P3-a）
 *
 * 背景：REST 类型唯一正本 = @dommaker/studio-contract（zod schema）。前端各域
 * api 文件的手抄 interface 已在契约驱动迁移（2026-10 批次 1~8）中清零改 contract
 * import，本规则防止手抄类型回潮。
 *
 * 硬规则：apps/web/src/api/*.ts 禁止 `export interface` / `export type X = ...` 声明。
 * 放行形态（均锚定契约、不产漂移面）：
 *   - re-export：`export type { X }` / `export type { X } from '...'`
 *   - 契约别名：`export type X = ContractX`（含泛型，如 PaginatedResponse<T> = PaginatedBody<T>）
 * 纯客户端本地类型（SSE 负载 / UI 本地标记）→ 住 src/types/。
 */

export default {
  meta: {
    type: 'problem',
    docs: { description: 'api 层禁止声明导出手抄类型（contract import 别名 / re-export 例外）' },
    schema: [],
    messages: {
      noInterface:
        '禁止在 api 层导出 interface「{{ name }}」：REST 类型正本在 @dommaker/studio-contract。契约缺此类型 → 在 contract 补 schema 后 import；纯客户端本地类型 → 放 src/types/ 再 re-export。',
      noTypeAlias:
        '禁止在 api 层导出 type 别名「{{ name }}」（非契约引用形态）：放行形态仅 export type { X }（re-export）与 export type X = ContractX（契约别名）。本地类型放 src/types/。',
    },
  },
  create(context) {
    return {
      ExportNamedDeclaration(node) {
        const decl = node.declaration;
        if (!decl) return; // export type { X } [from '...'] —— re-export，放行
        if (decl.type === 'TSInterfaceDeclaration') {
          context.report({ node, messageId: 'noInterface', data: { name: decl.id.name } });
          return;
        }
        if (decl.type === 'TSTypeAliasDeclaration') {
          const rhs = decl.typeAnnotation;
          // 契约别名形态：RHS 为裸标识符引用（含泛型实参），如 = ContractX / = PaginatedBody<T>
          const isContractRef =
            rhs.type === 'TSTypeReference' && rhs.typeName.type === 'Identifier';
          if (!isContractRef) {
            context.report({ node, messageId: 'noTypeAlias', data: { name: decl.id.name } });
          }
        }
      },
    };
  },
};
