// 设置页面 — #434 死配置清理后仅剩三个活节，全部组件内即时保存，无保存栏
import { DefaultExecutionMachineSection } from '../components/settings/DefaultExecutionMachineSection';
import { ProjectCandidatesSection } from '../components/settings/ProjectCandidatesSection';
import { ThemeSettings } from '../components/settings/ThemeSettings';
import '../styles/theme.css';

export function Settings() {
  return (
    <div className="h-full flex flex-col u-page-bg">
      <div className="u-page-head">
        <h1 className="page-title">设置</h1>
        <p className="page-subtitle">默认执行机器、工程候选与主题偏好</p>
      </div>

      <div className="flex-1 overflow-auto u-page-px pb-8">
        <div className="max-w-5xl space-y-8 mt-4">
          {/* 默认执行机器 — #286（决策 #251 Q2'）：频道级 WU 执行机器绑定（从频道顶栏挪入） */}
          <DefaultExecutionMachineSection />

          {/* 工程候选管理 — #266（决策 #258） */}
          <ProjectCandidatesSection />

          {/* 主题（最下面） */}
          <section className="space-y-4">
            <h2 className="mc-block-label" style={{ margin: 0 }}>主题设置</h2>
            <ThemeSettings />
          </section>
        </div>
      </div>
    </div>
  );
}

export default Settings;
