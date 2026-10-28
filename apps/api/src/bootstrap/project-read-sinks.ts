/** ARCH-04 ProjectReadPort 组合步骤；实现经模块公共面进入组合根。 */
import { projectRead } from '../modules/pmo/index.js';
import { registerProjectReadPort } from '../modules/requirements/index.js';

export function registerProjectReadSink(): void {
  registerProjectReadPort(projectRead);
}
