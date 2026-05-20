// slugify.ts - 生成 URL 友好的目录名称
/**
 * 将字符串转换为 URL 友好的 slug
 * 
 * @param text - 输入文本（如项目名称）
 * @returns slug 字符串（如 "my-project"）
 * 
 * @example
 * slugify("My Project") // "my-project"
 * slugify("Hello World!") // "hello-world"
 * slugify("测试项目") // "ce-shi-xiang-mu"
 */
export function slugify(text: string): string {
  if (!text || typeof text !== 'string') {
    return `project-${Date.now()}`;
  }

  return text
    // 转换为小写
    .toLowerCase()
    // 去除首尾空格
    .trim()
    // 替换空格为连字符
    .replace(/\s+/g, '-')
    // 移除特殊字符（只保留字母、数字、连字符）
    .replace(/[^a-z0-9-\u4e00-\u9fa5]/g, '')
    // 将中文字符转换为拼音首字母（简化处理）
    .replace(/[\u4e00-\u9fa5]/g, (char) => {
      // 简化的拼音映射（常见字）
      const pinyinMap: Record<string, string> = {
        '测': 'ce', '试': 'shi', '项': 'xiang', '目': 'mu',
        '新': 'xin', '建': 'jian', '开': 'kai', '发': 'fa',
        '工': 'gong', '作': 'zuo',
        '流': 'liu', '程': 'cheng', '步': 'bu', '骤': 'zhou',
        '管': 'guan', '理': 'li', '系': 'xi', '统': 'tong',
      };
      return pinyinMap[char] || 'x';
    })
    // 合并多个连字符为一个
    .replace(/-+/g, '-')
    // 移除首尾的连字符
    .replace(/^-+|-+$/g, '')
    // 限制长度（最长 50 个字符）
    .substring(0, 50)
    // 如果为空，使用时间戳
    || `project-${Date.now()}`;
}

/**
 * 生成唯一的项目目录名称
 * 
 * @param baseName - 基础名称（如项目名称）
 * @param existingNames - 已存在的目录名称列表（用于避免冲突）
 * @returns 唯一的目录名称
 * 
 * @example
 * generateUniqueSlug("My Project", ["my-project"]) // "my-project-1"
 * generateUniqueSlug("New Project", []) // "new-project"
 */
export function generateUniqueSlug(
  baseName: string,
  existingNames: string[] = []
): string {
  let slug = slugify(baseName);
  let counter = 1;
  
  // 如果 slug 已存在，添加数字后缀
  while (existingNames.includes(slug)) {
    slug = `${slugify(baseName)}-${counter}`;
    counter++;
    
    // 防止无限循环
    if (counter > 1000) {
      slug = `${slugify(baseName)}-${Date.now()}`;
      break;
    }
  }
  
  return slug;
}

export default slugify;
