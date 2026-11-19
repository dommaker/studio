/** WU → PMO 创建期归因戳的跨域纯解析；canonical metadata key = `pmoId`。 */
export function parseWuPmoId(metadata: string | null | undefined): string | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as { pmoId?: unknown };
    return typeof meta.pmoId === 'string' && meta.pmoId ? meta.pmoId : null;
  } catch {
    return null;
  }
}
