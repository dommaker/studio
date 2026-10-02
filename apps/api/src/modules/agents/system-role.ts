/**
 * 系统角色身份断言（#631）——门面转介。
 * 实现已下沉 core/system-role.ts（P2-c：agents/channels 双方消费的纯原语不该挂在域模块里），
 * agents 模块内消费方与 agents/index.ts 公共面路径不变。
 */
export { STUDIO_ROLE_NAME, isSystemRole } from '../../core/system-role.js';
