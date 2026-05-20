// i18n/index.ts - 国际化配置
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// 导入翻译文件
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

// 翻译资源
const resources = {
  'zh-CN': { translation: zhCN },
  'en-US': { translation: enUS },
};

i18n
  .use(LanguageDetector) // 自动检测用户语言
  .use(initReactI18next) // 绑定 react-i18next
  .init({
    resources,
    fallbackLng: 'zh-CN', // 默认中文
    supportedLngs: ['zh-CN', 'en-US'],
    
    interpolation: {
      escapeValue: false, // React 已经处理 XSS
    },
    
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
  });

export default i18n;

// 语言切换函数
export const changeLanguage = (lang: 'zh-CN' | 'en-US') => {
  i18n.changeLanguage(lang);
};

// 获取当前语言
export const getCurrentLanguage = () => {
  return i18n.language || 'zh-CN';
};

// 支持的语言列表
export const supportedLanguages = [
  { code: 'zh-CN', name: '简体中文', flag: '🇨🇳' },
  { code: 'en-US', name: 'English', flag: '🇺🇸' },
];