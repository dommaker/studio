/**
 * studio-dir — STUDIO_HOME 数据根解析单入口
 *
 * 纯函数、无副作用（warn 除外）：读 STUDIO_HOME，缺省回退 ~/.studio。
 * 全部硬编码数据根路径应收口到本模块，替代 `path.join(os.homedir(), '.studio', ...)`。
 */

import os from 'node:os';
import * as osNs from 'node:os';
import * as path from 'node:path';

// 测试隔离兼容（vitest 内建模块双视图）。仓库现存四种 os.homedir 隔离方式，
// 各自只对一个 import 视图可见：
//   A. vi.mock 工厂 {...actual, homedir}  → 仅 namespace 视图
//   B. vi.mock 工厂 {default: {homedir}}  → 仅 default 视图（namespace 无该导出）
//   C. 运行期 vi.spyOn(os 默认导出)        → 仅 default 视图（module.exports 活对象）
//   D. 模块加载前 require 补丁             → 两视图均可见
// 以模块求值时的两视图值为基准：求值后某视图被改写则取该视图（C）；两基准值本身
// 不一致说明模块级 vi.mock 注入，取 namespace 视图（A）；其余取 default 视图
// （B/D/正常）。生产环境两视图恒等，行为与 os.homedir() 完全一致。
function readNsHomedir(): string | undefined {
  try {
    return typeof osNs.homedir === 'function' ? osNs.homedir() : undefined;
  } catch {
    return undefined; // B 类 mock 的 namespace 无 homedir 导出，访问即抛
  }
}

const initialDefaultHomedir = os.homedir();
const initialNsHomedir = readNsHomedir();

function resolveHomedir(): string {
  const viaDefault = os.homedir();
  if (viaDefault !== initialDefaultHomedir) return viaDefault;
  const viaNs = readNsHomedir();
  if (viaNs !== undefined && (viaNs !== initialNsHomedir || viaNs !== viaDefault)) return viaNs;
  return viaDefault;
}

/**
 * 缺省数据根 ~/.studio。os.homedir() 在 POSIX 动态读 $HOME，测试隔离行为不变。
 */
export function defaultStudioDir(): string {
  return path.join(resolveHomedir(), '.studio');
}

/**
 * 数据根目录：STUDIO_HOME 优先，缺省 ~/.studio。
 */
export function studioDir(): string {
  return process.env.STUDIO_HOME || defaultStudioDir();
}

/**
 * 数据根下的路径拼接。
 */
export function studioPath(...segments: string[]): string {
  return path.join(studioDir(), ...segments);
}

let warnedNonProdProdRoot = false;

/**
 * 软护栏：非 production 环境指向生产缺省根时 console.warn（每进程一次）。
 */
export function warnIfNonProdUsesProdRoot(): void {
  if (warnedNonProdProdRoot) return;
  if (process.env.NODE_ENV === 'production') return;
  // 两侧 path.resolve 归一化，防尾斜杠/相对路径绕过软护栏
  if (path.resolve(studioDir()) !== path.resolve(defaultStudioDir())) return;
  warnedNonProdProdRoot = true;
  console.warn(
    `[studio] WARNING: NODE_ENV=${process.env.NODE_ENV ?? 'unset'} 但数据根为生产缺省根 ${defaultStudioDir()}，`
    + 'dev/test 进程将与 prod 混写同一数据区。请设置 STUDIO_HOME（如 ~/.studio-dev）隔离。',
  );
}
