// Trigger Action — execute trigger actions (3.28c-4)
// Currently supports: CREATE WorkUnit
import { prisma } from '@dommaker/studio-prisma';
import type { TriggerAction } from './trigger.types.js';

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

  if (action.target !== 'WorkUnit') {
    throw new Error(`Unknown target: ${action.target}`);
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
