/**
 * foldJsonlById 测试（#360）
 *
 * 共享 JSONL append-only 折叠：按 id 分组、每组取最新一行；作废（墓碑）判据由
 * 业务传入。钉住契约：分组/最新行/首现位置序/墓碑收尾/数据载体/墓碑全集序。
 */
import { describe, it, expect } from 'vitest';
import { foldJsonlById } from '../jsonl-fold';

interface Row {
  id: string;
  v?: number;
  deleted?: boolean;
  kind?: 'data' | 'status';
  at?: string;
}

const isDeleted = (r: Row): boolean => r.deleted === true;
const isStatus = (r: Row): boolean => r.kind === 'status';

describe('foldJsonlById', () => {
  it('空输入返回空 Map', () => {
    expect(foldJsonlById([], isDeleted).size).toBe(0);
  });

  it('按 id 分组，每组取最新一行', () => {
    const rows: Row[] = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'a', v: 2 },
    ];
    const folded = foldJsonlById(rows, isDeleted);
    expect(folded.size).toBe(2);
    expect(folded.get('a')!.latest.v).toBe(2);
    expect(folded.get('b')!.latest.v).toBe(1);
  });

  it('Map 迭代序 = id 首现位置序（与 channels mergeActiveRows 现口径一致）', () => {
    const rows: Row[] = [
      { id: 'b', v: 1 },
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ];
    expect([...foldJsonlById(rows, isDeleted).keys()]).toEqual(['b', 'a']);
  });

  it('墓碑行收尾 -> voided=true（channels #319 口径的整组死亡信号）', () => {
    const rows: Row[] = [
      { id: 'a', v: 1 },
      { id: 'a', deleted: true, at: 't1' },
    ];
    const g = foldJsonlById(rows, isDeleted).get('a')!;
    expect(g.voided).toBe(true);
    expect(g.latest.deleted).toBe(true);
  });

  it('墓碑行后又有同 id 数据行 -> voided=false，data 复活为最新数据行', () => {
    const rows: Row[] = [
      { id: 'a', v: 1 },
      { id: 'a', deleted: true },
      { id: 'a', v: 2 },
    ];
    const g = foldJsonlById(rows, isDeleted).get('a')!;
    expect(g.voided).toBe(false);
    expect(g.data!.v).toBe(2);
    expect(g.latest.v).toBe(2);
  });

  it('data = 最新非作废行（数据载体）；无墓碑时 data===latest', () => {
    const rows: Row[] = [
      { id: 'a', v: 1 },
      { id: 'a', v: 2 },
    ];
    const g = foldJsonlById(rows, isDeleted).get('a')!;
    expect(g.data!.v).toBe(2);
    expect(g.data).toBe(g.latest);
  });

  it('组内全为作废行 -> data=null（孤儿墓碑，不可见）', () => {
    const rows: Row[] = [{ id: 'a', deleted: true, at: 't1' }];
    const g = foldJsonlById(rows, isDeleted).get('a')!;
    expect(g.data).toBeNull();
    expect(g.voided).toBe(true);
    expect(g.tombstones.length).toBe(1);
  });

  it('tombstones 保留文件序：首个供 notification readAt，末个供 distill status', () => {
    const rows: Row[] = [
      { id: 'a', deleted: true, at: 't1' },
      { id: 'a', v: 1 },
      { id: 'a', deleted: true, at: 't2' },
      { id: 'a', deleted: true, at: 't3' },
    ];
    const g = foldJsonlById(rows, isDeleted).get('a')!;
    expect(g.tombstones.map(t => t.at)).toEqual(['t1', 't2', 't3']);
    expect(g.tombstones[0]!.at).toBe('t1');
    expect(g.tombstones[g.tombstones.length - 1]!.at).toBe('t3');
  });

  it('作废判据由业务传入（kind=status 口径，distill/role-memory 双流折叠）', () => {
    const rows: Row[] = [
      { id: 'a', kind: 'data', v: 1 },
      { id: 'a', kind: 'status', at: 't1' },
      { id: 'a', kind: 'status', at: 't2' },
    ];
    const g = foldJsonlById(rows, isStatus).get('a')!;
    expect(g.data!.kind).toBe('data');
    expect(g.data!.v).toBe(1);
    expect(g.tombstones.length).toBe(2);
    expect(g.tombstones[g.tombstones.length - 1]!.at).toBe('t2'); // 末个 status = 最新状态
    expect(g.voided).toBe(true);
  });

  it('混合多 id：各 id 独立折叠', () => {
    const rows: Row[] = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'a', deleted: true },
      { id: 'c', v: 1 },
      { id: 'b', v: 2 },
      { id: 'a', v: 2 },
    ];
    const folded = foldJsonlById(rows, isDeleted);
    expect(folded.get('a')!.voided).toBe(false);
    expect(folded.get('a')!.data!.v).toBe(2);
    expect(folded.get('a')!.tombstones.length).toBe(1);
    expect(folded.get('b')!.data!.v).toBe(2);
    expect(folded.get('b')!.tombstones.length).toBe(0);
    expect(folded.get('c')!.voided).toBe(false);
    expect([...folded.keys()]).toEqual(['a', 'b', 'c']);
  });
});
