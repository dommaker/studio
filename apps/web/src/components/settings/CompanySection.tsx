// 公司信息 section（从 pages/Settings.tsx 抽取，工单 35-E3）：公司名称自动保存 + 无公司时创建
// 工单 38: 公司名自动保存加防抖（500ms，仓内惯例见 WikiPage debounceRef / useWorkUnitEvents），
// 本地 draft 态保证防抖期间输入即时回显，不被受控值回退打断
import { useEffect, useRef, useState } from 'react';
import { companyApi } from '../../api/company';
import { toast } from '../../utils/toast';

export interface Company { id: string; name: string; size: string }

interface CompanySectionProps {
  company: Company | null;
  newCompanyName: string;
  setCompany: (company: Company | null) => void;
  setNewCompanyName: (name: string) => void;
}

const AUTOSAVE_DEBOUNCE_MS = 500;

export function CompanySection({ company, newCompanyName, setCompany, setNewCompanyName }: CompanySectionProps) {
  const [draftName, setDraftName] = useState(company?.name ?? '');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 公司切换/新建后同步本地草稿
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDraftName(company?.name ?? ''); }, [company?.id]);

  // 卸载时清掉未触发的防抖计时器
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const handleNameChange = (value: string) => {
    if (!company) {
      setNewCompanyName(value);
      return;
    }
    setDraftName(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // 空名称不落库（避免误清空公司名）
      if (!value.trim()) return;
      companyApi.update(company.id, { name: value }).then(() => {
        setCompany({ ...company, name: value });
      }).catch(err => { console.error('Auto-save failed:', err); toast.error('自动保存失败'); });
    }, AUTOSAVE_DEBOUNCE_MS);
  };

  return (
    <section className="space-y-4">
      <h2 className="mc-block-label" style={{ margin: 0 }}>🏢 公司信息</h2>

      <div className="card p-4 space-y-4">
        {/* 公司名称 */}
        <div>
          <label className="block text-sm font-medium mb-2 u-text-2">公司名称</label>
          <input type="text" value={company ? draftName : newCompanyName}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="输入公司名称" className="input w-full" />
        </div>

        {/* 如果没有公司，显示创建提示 */}
        {!company && newCompanyName.trim() && (
          <button onClick={() => {
            companyApi.create({ name: newCompanyName }).then(res => {
              if (res.data?.id) {
                localStorage.setItem('companyId', res.data.id);
                setCompany(res.data);
              }
            }).catch(err => toast.error('创建失败: ' + err.message));
          }} className="btn btn-primary text-sm">保存为新公司</button>
        )}
      </div>
    </section>
  );
}
