/**
 * R2 事件目录统一（断点 D，docs/plans/2026-07-flywheel-repair.md）。
 *
 * 唯一事件目录 = `~/.studio/events`，可用环境变量覆盖。
 * 环境变量优先级（收敛为一个规范名 + 向后兼容历史名）：
 *   1. `STUDIO_EVENTS_DIR` — 规范名（优先）
 *   2. `EVENTS_DIR`        — 历史名（向后兼容；apps/api index.ts 与 studio-cli
 *                            启动时仍会把它默认设为 ~/.studio/events）
 *   3. 默认 `~/.studio/events`
 *
 * ⚠️ D18（B5，2026-07-27）变更：apps/api 内的事件读写已全部收敛到
 * `~/.studio/logs/studio-events.jsonl`（单一文件单一入口，见
 * apps/api/src/utils/studio-events.ts 的 writeStudioEvent/readStudioEvents）。
 * 本 resolver 目前仅服务仓库外的遗留消费方（如 events-daemon 的目录约定），
 * apps/api 内不再有生产调用方；新代码请使用 utils/studio-events。
 */
export declare function resolveEventsDir(): string;
//# sourceMappingURL=events-dir.d.ts.map