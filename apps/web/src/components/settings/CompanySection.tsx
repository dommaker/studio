// 公司信息 section（从 pages/Settings.tsx 抽取，工单 35-E3）：公司名称自动保存 + 无公司时创建
import { companyApi } from '../../api/company';
import { toast } from '../../utils/toast';

export interface Company { id: string; name: string; size: string }

interface CompanySectionProps {
  company: Company | null;
  newCompanyName: string;
  setCompany: (company: Company | null) => void;
  setNewCompanyName: (name: string) => void;
}

export function CompanySection({ company, newCompanyName, setCompany, setNewCompanyName }: CompanySectionProps) {
  return (
    <section className="space-y-4">
      <h2 className="mc-block-label" style={{ margin: 0 }}>🏢 公司信息</h2>

      <div className="card p-4 space-y-4">
        {/* 公司名称 */}
        <div>
          <label className="block text-sm font-medium mb-2 u-text-2">公司名称</label>
          <input type="text" value={company?.name || newCompanyName}
            onChange={(e) => {
              setNewCompanyName(e.target.value);
              if (company) {
                // 自动保存
                companyApi.update(company.id, { name: e.target.value }).then(() => {
                  setCompany({ ...company!, name: e.target.value });
                }).catch(err => { console.error('Auto-save failed:', err); toast.error('自动保存失败'); });
              }
            }}
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
