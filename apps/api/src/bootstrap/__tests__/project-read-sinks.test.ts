/** ARCH-04：组合根把 PMO 只读实现原样注入 Requirements 端口。 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockProjectRead, mockRegisterProjectReadPort } = vi.hoisted(() => ({
  mockProjectRead: { get: vi.fn() },
  mockRegisterProjectReadPort: vi.fn(),
}));

vi.mock('../../modules/pmo/index.js', () => ({ projectRead: mockProjectRead }));
vi.mock('../../modules/requirements/index.js', () => ({ registerProjectReadPort: mockRegisterProjectReadPort }));

import { registerProjectReadSink } from '../project-read-sinks.js';

beforeEach(() => vi.clearAllMocks());

describe('bootstrap/project-read-sinks', () => {
  it('注册 PMO projectRead，不注入 CRUD/publish facade', () => {
    registerProjectReadSink();
    expect(mockRegisterProjectReadPort).toHaveBeenCalledOnce();
    expect(mockRegisterProjectReadPort).toHaveBeenCalledWith(mockProjectRead);
  });
});
