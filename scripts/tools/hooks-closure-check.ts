/**
 * hooks-closure-check — 构建期完整性断言（#150 C1 / #202）
 *
 * 声明表（hooks/config.ts getAllHookConfigs）↔ 导出即注册定义
 * （hooks/register.ts buildHookDefinitions）双向闭环校验，机器闸门取代
 * `hook_must_be_registered` prompt 规矩：新增 hook 函数必须同文件导出
 * HookDefinition 并在声明表登记，否则本脚本非零退出。
 *
 * 挂载：packages/studio-shared 的 build 脚本（tsc 之后）。
 * 可测性：核心逻辑抽为 checkHooksClosure 纯函数，主执行仅在被直接
 * 运行（tsx 本文件）时触发，vitest import 不产生副作用。
 */
import { pathToFileURL } from 'url';
import { assertHookRegistryClosed } from '@dommaker/harness';
import { getAllHookConfigs } from '../../packages/studio-shared/src/harness/hooks/config';
import { buildHookDefinitions } from '../../packages/studio-shared/src/harness/hooks/register';

/** 闭环检查结果（纯函数，供脚本与测试共用） */
export function checkHooksClosure(): { ok: boolean; message: string } {
  try {
    const configs = getAllHookConfigs();
    const defs = buildHookDefinitions();
    assertHookRegistryClosed(configs, defs);
    return { ok: true, message: `✅ hooks-closure-check: ${configs.length} 声明 ↔ ${defs.length} 注册定义闭环` };
  } catch (err) {
    return { ok: false, message: `❌ hooks-closure-check 失败: ${(err as Error).message}` };
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { ok, message } = checkHooksClosure();
  console.log(message);
  process.exit(ok ? 0 : 1);
}
