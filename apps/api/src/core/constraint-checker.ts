/**
 * 约束检查模块
 * 
 * Iron Laws 检查（内部实现）
 */

import type { Request } from 'express';

export const IRON_LAWS = {
  verify_external_capability: {
    id: 'verify_external_capability',
    rule: 'VERIFY EXTERNAL CAPABILITY BEFORE IMPLEMENTATION',
    message: '外部依赖能力必须先验证',
  },
};

export interface DesignCheckContext {
  hasExternalDependency: boolean;
  hasCallbackMechanism: boolean;
  verified: boolean;
}

export function checkDesignConstraints(context: DesignCheckContext): string[] {
  if (context.hasExternalDependency && !context.verified) {
    return [IRON_LAWS.verify_external_capability.message];
  }
  return [];
}

export function extractDesignContext(req: Request): DesignCheckContext {
  return {
    hasExternalDependency: req.body.source === 'discord',
    hasCallbackMechanism: req.body.components?.length > 0,
    verified: false,
  };
}
