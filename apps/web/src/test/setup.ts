// 不用 '@testing-library/jest-dom/vitest' 入口：jest-dom 未声明 vitest peer，
// 该入口被外部化后在 pnpm monorepo 里解析到另一 peer 变体的 vitest 副本，
// 导致 @vitest/snapshot 单例分裂、快照断言报 "snapshot state not found"
// （vitest#7430/#7668）。改为显式 expect.extend，与入口 matcher 集合等同。
import { expect, afterEach } from 'vitest';
import * as jestDomMatchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';

expect.extend(jestDomMatchers);

// React 19 CJS interop: `act` is an ESM-only named export.
// Add it to the CJS module so react-dom/test-utils can find React.act.
// vi.mock('react') in each test file provides the polyfill.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});