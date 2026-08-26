// zh-CN 时间格式唯一出口（#358：6 处 formatTime 逐字拷贝 + 6 处内联 toLocaleString 收口）。
// 短格式两份方言（null→'-' / try-catch→原样）合一：toLocaleString 对 string 输入不抛（try-catch 为死分支），
// 空值统一回 '-'；非法输入与原拷贝一致输出 'Invalid Date'。

const SHORT_OPTS = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } as const;

/** zh-CN 短格式「MM/DD HH:mm」；空值回 `-` */
export function formatShortTime(ts: string | Date | null | undefined): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', SHORT_OPTS);
}

/** zh-CN 全格式（原内联 new Date(x).toLocaleString('zh-CN') ×6） */
export function formatFullTime(ts: string): string {
  return new Date(ts).toLocaleString('zh-CN');
}
