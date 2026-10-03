/**
 * core/store — apps/api 进程级 FileStore 唯一获取口（P2-b 存储边界收口）
 *
 * 架构硬规则（docs/architecture/target-architecture.md）：生产代码禁无参
 * `new FileStore()`（eslint error 级），消费方一律 getStore()，禁模块级单例、
 * 禁 import 期捕获（模块级 const s = getStore() 会冻结实例——一律函数内调用时获取）。
 *
 * 两个关键设计（均为测试隔离架构所迫，勿"简化"掉）：
 * 1. 构造必须经本模块对 '@dommaker/studio-shared' 的 import 发生——37 个测试
 *    vi.mock('@dommaker/studio-shared') 替换 FileStore 为 mock 类，拦截点就是这个
 *    specifier；若委托包内 getDefaultFileStore() 构造（直达 './file-store' 真实类），
 *    mock 全灭（P2-b 首轮 160 个测试失败的根因）。packages 侧持有器
 *    （studio-shared file-store-default.ts）只服务 packages 消费方。
 * 2. 未 init 时惰性兜底：按「当前 env 解析根」（STUDIO_DATA_DIR ?? STUDIO_HOME/data）
 *    建实例并按根缓存，env 变根 → 新实例——与历史「改 env 后新构造」逐点等价
 *    （vitest setup 钉隔离根 / 38 个动态 env 测试依赖）。
 *
 * 时序：bootstrap() 在 initConfig() 之后、runDataMigrations() 之前调 initStore() 钉定，
 * 并经 setDefaultFileStore 同步钉定 packages 持有器——生产态 apps/api 与 packages
 * 共享同一实例。
 */
import { FileStore, setDefaultFileStore, resetDefaultFileStoreForTesting } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

/** 按数据根缓存的惰性实例（未钉定时的兜底面） */
const storesByRoot = new Map<string, FileStore>();
/** 显式钉定的实例（initStore 后生效） */
let pinned: FileStore | undefined;

/** 与 FileStore 无参构造同源的数据根解析式 */
function resolveDefaultRoot(): string {
  return process.env.STUDIO_DATA_DIR ?? studioPath('data');
}

/**
 * 启动期钉定进程级 FileStore（bootstrap 调一次）。
 * root 缺省 = 复用 env 解析根的惰性缓存实例，保证早于此调用的 import 期捕获
 * （存量模块级 `new XService(getStore())`）与钉定后是同一实例；显式 root 则新建并钉定。
 */
export function initStore(root?: string): FileStore {
  const store = root === undefined ? getStore() : new FileStore(root);
  pinned = store;
  setDefaultFileStore(store);
  return store;
}

/** 获取进程级 FileStore（消费方唯一入口；函数内调用时获取，禁模块级捕获） */
export function getStore(): FileStore {
  if (pinned) return pinned;
  const root = resolveDefaultRoot();
  let store = storesByRoot.get(root);
  if (!store) {
    store = new FileStore(root);
    storesByRoot.set(root, store);
  }
  return store;
}

/** 测试专用：清除钉定与惰性缓存（业务代码/业务测试不应调用） */
export function resetStoreForTesting(): void {
  pinned = undefined;
  storesByRoot.clear();
  resetDefaultFileStoreForTesting();
}
