/**
 * 创建懒加载单例服务
 *
 * 用法: const getMyService = createLazyService(() => new MyService(prisma));
 * 调用: getMyService() 返回单例
 */
export function createLazyService<T>(factory: () => T): () => T {
  let instance: T | undefined;
  return () => {
    if (!instance) {
      instance = factory();
    }
    return instance;
  };
}
