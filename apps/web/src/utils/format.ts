/**
 * 格式化 Token 数量
 * 
 * 显示规则：
 * - < 1,000: 原数值 tokens
 * - 1K - 100K: X.XK tokens 或 XK tokens
 * - 100K - 1M: XK tokens
 * - 1M+: X.XM tokens 或 XM tokens
 */
export function formatTokens(value: number): string {
  if (value < 1000) {
    return `${value} tokens`;
  }
  
  if (value < 10000) {
    // 1K - 10K: 显示小数
    return `${(value / 1000).toFixed(1)}K tokens`;
  }
  
  if (value < 100000) {
    // 10K - 100K: 显示整数 K
    return `${Math.round(value / 1000)}K tokens`;
  }
  
  if (value < 1000000) {
    // 100K - 1M: 显示整数 K
    return `${Math.round(value / 1000)}K tokens`;
  }
  
  if (value < 10000000) {
    // 1M - 10M: 显示小数 M
    return `${(value / 1000000).toFixed(1)}M tokens`;
  }
  
  // >= 10M: 显示整数 M
  return `${Math.round(value / 1000000)}M tokens`;
}

/**
 * 格式化短 Token 数量（不含 "tokens" 后缀）
 * 用于表格、紧凑显示
 */
export function formatTokensShort(value: number): string {
  if (value < 1000) {
    return `${value}`;
  }
  
  if (value < 10000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  
  if (value < 1000000) {
    return `${Math.round(value / 1000)}K`;
  }
  
  if (value < 10000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  
  return `${Math.round(value / 1000000)}M`;
}