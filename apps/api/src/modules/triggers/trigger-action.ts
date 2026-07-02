// Trigger Action — execute trigger actions (3.28c-4, AS-026 extended)
// Supports: CREATE WorkUnit, EXECUTE handler, UPDATE entity
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import type { TriggerAction, TriggerExecuteHandler } from './trigger.types.js';

/** Handler registry for EXECUTE actions */
const executeHandlers = new Map<string, TriggerExecuteHandler>();

/** Register a handler for EXECUTE actions */
export function registerExecuteHandler(target: string, handler: TriggerExecuteHandler): void {
  executeHandlers.set(target, handler);
}

/** Unregister a handler */
export function unregisterExecuteHandler(target: string): void {
  executeHandlers.delete(target);
}

/**
 * Execute a CREATE action — creates a WorkUnit from trigger payload.
 * @param action - The trigger action definition
 * @param triggerId - The trigger ID (stored in WorkUnit metadata for traceability)
 * @returns The created WorkUnit
 */
export async function executeCreateAction(
  action: TriggerAction,
  triggerId: string,
): Promise<{ id: string; type: string; scope: string; status: string; channelId: string | null; metadata: string | null }> {
  if (action.type !== 'CREATE') {
    throw new Error(`Unknown action type: ${action.type}`);
  }

  const { type, scope, channelId, metadata } = action.payload;

  const mergedMetadata = JSON.stringify({
    ...(metadata || {}),
    triggerId,
    triggerSource: 'trigger-registry',
    triggeredAt: new Date().toISOString(),
  });

  const workUnit = await prisma.workUnit.create({
    data: {
      type,
      scope,
      channelId: channelId || null,
      metadata: mergedMetadata,
    },
  });

  return {
    id: workUnit.id,
    type: workUnit.type,
    scope: workUnit.scope,
    status: workUnit.status,
    channelId: workUnit.channelId,
    metadata: workUnit.metadata,
  };
}

/**
 * Execute an EXECUTE action — calls a registered handler.
 * @param action - The trigger action definition (must be EXECUTE type)
 * @param context - Context passed to the handler (e.g. event payload)
 */
export async function executeExecuteAction(
  action: TriggerAction,
  context: unknown,
): Promise<void> {
  if (action.type !== 'EXECUTE') {
    throw new Error(`Expected EXECUTE action, got: ${action.type}`);
  }

  const handler = executeHandlers.get(action.target);
  if (!handler) {
    logger.warn(`[TriggerAction] No handler registered for execute target: ${action.target}`);
    return;
  }

  await handler(context);
}

/**
 * Execute an UPDATE action — updates entity via prisma.
 * @param action - The trigger action definition (must be UPDATE type)
 */
export async function executeUpdateAction(
  action: TriggerAction,
  _context: unknown,
): Promise<void> {
  if (action.type !== 'UPDATE') {
    throw new Error(`Expected UPDATE action, got: ${action.type}`);
  }

  const query = action.config.query;
  const update = action.config.update;

  // Only support workunit entity for MVP
  if (action.target === 'workunit') {
    await prisma.workUnit.updateMany({ where: query, data: update });
  } else {
    logger.warn(`[TriggerAction] Unknown UPDATE target: ${action.target}`);
  }
}
