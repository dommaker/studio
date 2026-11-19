// 拆分来源：pages/MonitoringPage.tsx「角色效率」MonitorSection 整块（纯 JSX 平移）
import { MonitorSection } from './MonitorSection';
import type { OverviewMetrics } from '@dommaker/studio-contract';

/** 角色效率表格行（= /monitoring/overview roles.roles 数组项；契约只导出外层 RoleMetrics 组，
 *  数组项类型自此派生，与页面 `overview?.roles.roles` 推断形状一致） */
type RoleMetricsEntry = OverviewMetrics['roles']['roles'][number];

/** §7.3 新引入：角色效率表格（claims/完成/均时/NEED_INPUT 拆分） */
export function RolesEfficiencySection({ roles }: { roles: RoleMetricsEntry[] }) {
  return (
    <MonitorSection title="角色效率" subtitle="每个角色认领、完成了多少任务、平均多久">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs u-text-3 text-left">
            <th className="py-1 font-normal">角色</th>
            <th className="py-1 font-normal">认领</th>
            <th className="py-1 font-normal">完成</th>
            <th className="py-1 font-normal">平均时长</th>
            <th className="py-1 font-normal">提问（澄清/执行）</th>
          </tr>
        </thead>
        <tbody>
          {roles.map(r => (
            <tr key={r.profileId} className="border-t u-border">
              <td className="py-1 u-text">{r.profileName}</td>
              <td className="py-1 font-mono">{r.claims}</td>
              <td className="py-1 font-mono">{r.completions}</td>
              <td className="py-1 font-mono">{r.avgDurationHours !== null ? `${Math.round(r.avgDurationHours * 10) / 10}h` : 'N/A'}</td>
              <td className="py-1 font-mono">{r.needInputClarify} / {r.needInputExecution}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </MonitorSection>
  );
}
