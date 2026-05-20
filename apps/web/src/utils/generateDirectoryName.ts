// generateDirectoryName.ts - 自动生成项目目录名称
/**
 * 根据项目名称生成目录名称
 * 
 * 规则：
 * 1. 转换为小写
 * 2. 空格替换为连字符
 * 3. 移除特殊字符（只保留字母、数字、连字符）
 * 4. 移除开头和结尾的连字符
 * 5. 限制长度（最多 50 个字符）
 * 
 * @param projectName 项目名称
 * @returns 目录名称
 * 
 * @example
 * generateDirectoryName("My Project") // "my-project"
 * generateDirectoryName("Agent Studio 2026!") // "agent-studio-2026"
 * generateDirectoryName("测试项目") // "ce-shi-xiang-mu" (拼音转换需要额外库)
 */
export function generateDirectoryName(projectName: string): string {
  if (!projectName || typeof projectName !== 'string') {
    return `project-${Date.now()}`;
  }

  // 转换为小写
  let directoryName = projectName.toLowerCase();

  // 移除特殊字符（只保留字母、数字、空格）
  directoryName = directoryName.replace(/[^a-z0-9\s-]/g, '');

  // 空格替换为连字符
  directoryName = directoryName.replace(/\s+/g, '-');

  // 多个连字符合并为一个
  directoryName = directoryName.replace(/-+/g, '-');

  // 移除开头和结尾的连字符
  directoryName = directoryName.replace(/^-+|-+$/g, '');

  // 限制长度
  if (directoryName.length > 50) {
    directoryName = directoryName.substring(0, 50);
  }

  // 如果处理后为空，使用时间戳
  if (!directoryName) {
    return `project-${Date.now()}`;
  }

  return directoryName;
}

/**
 * 检查目录名称是否有效
 * 
 * @param directoryName 目录名称
 * @returns 是否有效
 */
export function isValidDirectoryName(directoryName: string): boolean {
  if (!directoryName || typeof directoryName !== 'string') {
    return false;
  }

  // 检查格式：只包含小写字母、数字、连字符
  const validPattern = /^[a-z0-9-]+$/;
  if (!validPattern.test(directoryName)) {
    return false;
  }

  // 检查长度
  if (directoryName.length < 1 || directoryName.length > 50) {
    return false;
  }

  // 检查不以连字符开头或结尾
  if (directoryName.startsWith('-') || directoryName.endsWith('-')) {
    return false;
  }

  return true;
}

/**
 * 确保目录名称唯一（如果已存在，添加后缀）
 * 
 * @param baseName 基础名称
 * @param existingNames 已存在的名称列表
 * @returns 唯一的目录名称
 */
export function ensureUniqueDirectoryName(
  baseName: string,
  existingNames: string[] = []
): string {
  let directoryName = generateDirectoryName(baseName);
  
  if (!existingNames.includes(directoryName)) {
    return directoryName;
  }

  // 添加数字后缀
  let counter = 1;
  while (existingNames.includes(`${directoryName}-${counter}`)) {
    counter++;
  }

  return `${directoryName}-${counter}`;
}

export default generateDirectoryName;
