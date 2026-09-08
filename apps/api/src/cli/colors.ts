/**
 * 终端着色（chalk 最小替代面）
 *
 * update-user-model / analyze-sessions 自 harness 迁入时使用 chalk 的
 * gray/blue/green/yellow/cyan/bold/red 子集；studio 不引 chalk 依赖，
 * 在此实现同签名函数：TTY 且未设 NO_COLOR 时输出 ANSI 色，否则原样返回
 * （测试/管道场景输出保持纯文本）。
 */

const enabled = !!process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (open: number, close: number) =>
  (s: string): string => (enabled ? `[${open}m${s}[${close}m` : s);

const chalk = {
  gray: wrap(90, 39),
  blue: wrap(34, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  red: wrap(31, 39),
  bold: wrap(1, 22),
};

export default chalk;
