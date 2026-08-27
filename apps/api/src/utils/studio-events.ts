/**
 * 薄壳转发（#361）：D18 事件唯一写口实现下沉 @dommaker/studio-shared/src/studio-events.ts。
 * 此前 studio-agent output-capture / skills 直写够不着 apps/api 只能自抄 appendJsonl，
 * 且绕过 STUDIO_EVENTS_FILE 测试隔离（vitest 下 runner 事件落生产 logs）。
 * 收一后实现住共享包，本文件仅为 32 处既有 import 的兼容薄壳，勿新增逻辑。
 */
export {
  resolveStudioEventsFile,
  isEmptyEventPayload,
  defaultStudioEventLevel,
  writeStudioEvent,
  readStudioEvents,
  parseStudioEventPayload,
  getStudioEventTime,
} from '@dommaker/studio-shared';
export type { WriteStudioEventOptions, StudioEventLevel } from '@dommaker/studio-shared';
