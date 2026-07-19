import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { resolveEventsDir } from '../events-dir';

/**
 * R2 事件目录统一: resolveEventsDir()
 * 优先级 STUDIO_EVENTS_DIR（规范名） > EVENTS_DIR（历史名） > ~/.studio/events
 */
describe('resolveEventsDir (R2)', () => {
  const prevStudio = process.env.STUDIO_EVENTS_DIR;
  const prevLegacy = process.env.EVENTS_DIR;

  afterEach(() => {
    if (prevStudio === undefined) delete process.env.STUDIO_EVENTS_DIR;
    else process.env.STUDIO_EVENTS_DIR = prevStudio;
    if (prevLegacy === undefined) delete process.env.EVENTS_DIR;
    else process.env.EVENTS_DIR = prevLegacy;
  });

  it('defaults to ~/.studio/events when no env is set', () => {
    delete process.env.STUDIO_EVENTS_DIR;
    delete process.env.EVENTS_DIR;
    expect(resolveEventsDir()).toBe(join(homedir(), '.studio', 'events'));
  });

  it('honors STUDIO_EVENTS_DIR override', () => {
    process.env.STUDIO_EVENTS_DIR = '/tmp/studio-events-override';
    delete process.env.EVENTS_DIR;
    expect(resolveEventsDir()).toBe('/tmp/studio-events-override');
  });

  it('honors legacy EVENTS_DIR for backward compat', () => {
    delete process.env.STUDIO_EVENTS_DIR;
    process.env.EVENTS_DIR = '/tmp/legacy-events';
    expect(resolveEventsDir()).toBe('/tmp/legacy-events');
  });

  it('STUDIO_EVENTS_DIR wins when both are set', () => {
    process.env.STUDIO_EVENTS_DIR = '/tmp/canonical';
    process.env.EVENTS_DIR = '/tmp/legacy';
    expect(resolveEventsDir()).toBe('/tmp/canonical');
  });
});
