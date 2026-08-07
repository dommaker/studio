// 语言设置 section（从 pages/Settings.tsx 抽取，工单 35-E3）
import { changeLanguage, getCurrentLanguage, supportedLanguages } from '../../i18n';

export function LanguageSettings() {
  const currentLang = getCurrentLanguage();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {supportedLanguages.map((lang) => (
        <button key={lang.code} onClick={() => changeLanguage(lang.code as 'zh-CN' | 'en-US')}
          className="p-4 rounded-xl text-left transition-all flex items-center gap-3"
          style={{
            background: currentLang === lang.code || currentLang.startsWith(lang.code.split('-')[0]) ? 'var(--bg-elevated)' : 'var(--bg-tertiary)',
            border: currentLang === lang.code || currentLang.startsWith(lang.code.split('-')[0]) ? '2px solid var(--accent-primary)' : '2px solid var(--border-subtle)',
          }}>
          <span className="text-2xl">{lang.flag}</span>
          <div>
            <div className="font-medium u-text">{lang.name}</div>
            <div className="text-xs u-text-3">{lang.code === 'zh-CN' ? '默认语言' : 'English'}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
