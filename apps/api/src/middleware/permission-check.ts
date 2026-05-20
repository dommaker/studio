/**
 * 权限检查中间件
 * 
 * MR-004: 检查角色是否有权限执行操作
 */

import { Request, Response, NextFunction } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '../utils/logger.js';
import { hasPermission, getRequiredRoles } from '../config/permission-matrix.js';
import { getRoleLevel } from '../config/permission-matrix.js';

/**
 * 权限检查中间件
 * 
 * @param operation 操作名称（如 'create_meeting', 'end_meeting'）
 */
export function checkPermission(operation: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 获取角色 ID
      const roleId = req.body.roleId || req.body.creatorRoleId || req.params.roleId;

      if (!roleId) {
        return res.status(400).json({ error: '缺少角色信息（roleId）' });
      }

      // 查询角色
      const role = await prisma.role.findUnique({
        where: { id: roleId },
        select: { id: true, name: true },
      });

      if (!role) {
        return res.status(404).json({ error: '角色不存在' });
      }

      // 检查权限
      if (!hasPermission(role.name, operation)) {
        const requiredRoles = getRequiredRoles(operation);
        return res.status(403).json({
          error: '权限不足',
          required: requiredRoles,
          current: role.name,
        });
      }

      next();
    } catch (error) {
      logger.error({ error }, 'Permission check error');
      res.status(500).json({ error: '权限检查异常' });
    }
  };
}

/**
 * 扩展：检查角色层级
 * 
 * @param minLevel 最小权限级别（1-4）
 */
export function checkRoleLevel(minLevel: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const roleId = req.body.roleId;
      if (!roleId) {
        return res.status(400).json({ error: '缺少角色信息（roleId）' });
      }

      const role = await prisma.role.findUnique({
        where: { id: roleId },
        select: { id: true, name: true },
      });

      if (!role) {
        return res.status(404).json({ error: '角色不存在' });
      }

      const roleLevel = getRoleLevel(role.name);
      if (roleLevel < minLevel) {
        return res.status(403).json({
          error: '权限级别不足',
          requiredLevel: minLevel,
          currentLevel: roleLevel,
        });
      }

      next();
    } catch (error) {
      logger.error({ error }, 'Role level check error');
      res.status(500).json({ error: '权限检查异常' });
    }
  };
}