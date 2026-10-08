// ── 「失败只 log 不拒启」装配纪律的唯一固化点（#686）──
// listen 前移（ff546ba9）后，listen 后各初始化步一律失败只 warn 不拒启——
// 否则 throw 经 bootstrap catch 落到 process.exit(1)，发生在端口可服务之后
// （deploy 判绿后进程死亡、回滚不触发）。bridges/services/handlers/warmup
// 四处装配表共用本模块的单循环，新增步骤只需在对应表里加一行。
import { logger } from '@dommaker/studio-shared';

export interface SoftStep {
  /** warn 日志前缀用名 */
  readonly name: string;
  readonly run: () => unknown | Promise<unknown>;
}

function warnStepFailed(name: string, e: unknown): void {
  logger.warn(`[Bootstrap] ${name} failed (non-blocking)`, { error: String(e) });
}

/** 顺序执行装配步骤：单项失败只 warn，不阻断后续、不外抛。 */
export async function runSoftSteps(steps: readonly SoftStep[]): Promise<void> {
  for (const step of steps) {
    try {
      await step.run();
    } catch (e) {
      warnStepFailed(step.name, e);
    }
  }
}

/** fire-and-forget 挂载：同步返回，加载/挂载失败只 warn。 */
export function mountSoftSteps(steps: readonly SoftStep[]): void {
  for (const step of steps) {
    Promise.resolve()
      .then(() => step.run())
      .catch((e) => warnStepFailed(step.name, e));
  }
}
