/**
 * 约束检查测试路由
 * 
 * Iron Law #6 验证：先测试约束检查是否正常工作，再集成到关键路由
 */

import { Router } from 'express';
import { checkDesignConstraints, extractDesignContext, IRON_LAWS } from '../../core/constraint-checker.js';

const router = Router();

/**
 * GET /api/v1/test/constraint
 * 
 * 测试约束检查功能（不影响其他路由）
 */
router.get('/', async (req, res) => {
  res.json({
    message: '约束检查测试路由',
    ironLaws: Object.keys(IRON_LAWS),
    hint: '使用 POST 测试约束检查',
  });
});

/**
 * POST /api/v1/test/constraint
 * 
 * 测试约束检查功能
 * 
 * Body:
 * - source: "discord" | "api"
 * - components: [] (可选)
 * - verified: true | false (可选，模拟已验证)
 */
router.post('/', async (req, res) => {
  const context = extractDesignContext(req);
  
  // 如果请求中指定了 verified，覆盖默认值
  if (req.body.verified !== undefined) {
    context.verified = req.body.verified;
  }

  const violations = checkDesignConstraints(context);

  res.json({
    context,
    violations,
    passed: violations.length === 0,
    message: violations.length > 0 
      ? `发现 ${violations.length} 个违规：${violations.join(', ')}` 
      : '约束检查通过',
  });
});

export default router;