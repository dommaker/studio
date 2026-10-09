/**
 * 编译期互锚工具（#685）：schema 推型与源类型互相 extends 才通过，
 * 任一侧字段漂移即编译错误——替代已退役的手写 interface + parity 测试双写互验。
 *
 * 用法：`const _assertX: MutualExtends<z.infer<typeof xSchema>, SourceType> = true;`
 */
export type MutualExtends<A, B> = A extends B ? (B extends A ? true : never) : never;
