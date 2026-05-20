// LanguageSwitcher.tsx - 语言切换组件
import React from 'react';
import { changeLanguage, getCurrentLanguage, supportedLanguages } from '../i18n';

export const LanguageSwitcher: React.FC = () => {
  const currentLang = getCurrentLanguage();

  const handleLanguageChange = (langCode: string) => {
    changeLanguage(langCode as 'zh-CN' | 'en-US');
  };

  return (
    <div className="flex items-center gap-1">
      {supportedLanguages.map((lang) => (
        <button
          key={lang.code}
          onClick={() => handleLanguageChange(lang.code)}
          className={`px-2 py-1 rounded text-sm transition-colors ${
            currentLang === lang.code || currentLang.startsWith(lang.code.split('-')[0])
              ? 'bg-blue-100 text-blue-700'
              : 'hover:bg-gray-100'
          }`}
          title={lang.name}
        >
          {lang.flag}
        </button>
      ))}
    </div>
  );
};

export default LanguageSwitcher;