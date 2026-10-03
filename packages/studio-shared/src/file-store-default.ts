/**
 * file-store-default — 进程级默认 FileStore 持有器（P2-b 存储边界收口）
 *
 * 架构硬规则（docs/architecture/target-architecture.md）：`new FileStore()` 无参构造
 * 全仓唯一出处在本文件；消费方一律经访问口获取，禁模块级单例。
 *
 * 为什么持有器在 studio-shared 而不是 apps/api core/store.ts：
 * packages/* 不能反向依赖 apps/api，包内需要默认实例时只能由本包提供底层访问口。
 * apps/api 侧有自己的持有器 core/store.ts（构造必须经 api 对 '@dommaker/studio-shared'
 * 的 import 发生，测试 vi.mock 拦截点）；生产态 bootstrap initStore() 会把同一实例
 * 经 setDefaultFileStore 钉定到本持有器，api 与 packages 由此共享单例。
 *
 * 惰性语义（与历史 `new FileStore()` 逐点等价，测试隔离架构依赖此行为）：
 * - 未显式 setDefaultFileStore 时，按「当前 env 解析出的数据根」惰性建实例并按根缓存；
 *   env（STUDIO_DATA_DIR / STUDIO_HOME）变化 → 解析根变化 → 自动返回新实例，
 *   与历史上「改 env 后新构造」的行为一致（vitest 隔离 setup / 38 个动态 env 测试依赖）。
 * - setDefaultFileStore 钉定后恒返回该实例（生产 bootstrap 启动时钉一次）。
 */
import { FileStore } from './file-store';
import { studioPath } from './config/studio-dir';

/** 按数据根缓存的惰性实例（未钉定时的兜底面） */
const storesByRoot = new Map<string, FileStore>();
/** 显式钉定的实例（initStore / setDefaultFileStore 后生效） */
let pinned: FileStore | undefined;

/** 与 FileStore 无参构造同源的数据根解析式 */
function resolveDefaultRoot(): string {
  return process.env.STUDIO_DATA_DIR ?? studioPath('data');
}

/**
 * 获取进程默认 FileStore。
 * 已钉定 → 返回钉定实例；未钉定 → 按当前 env 解析根惰性建实例（按根缓存）。
 */
export function getDefaultFileStore(): FileStore {
  if (pinned) return pinned;
  const root = resolveDefaultRoot();
  let store = storesByRoot.get(root);
  if (!store) {
    store = new FileStore(root);
    storesByRoot.set(root, store);
  }
  return store;
}

/**
 * 钉定进程默认实例（生产 = apps/api bootstrap initStore() 启动早期调一次）。
 * 钉定后 getDefaultFileStore() 恒返回该实例，env 兜底面关闭。
 */
export function setDefaultFileStore(store: FileStore): void {
  pinned = store;
}

/** 测试专用：清除钉定与缓存（core/store 单测用；业务测试不应调用） */
export function resetDefaultFileStoreForTesting(): void {
  pinned = undefined;
  storesByRoot.clear();
}
