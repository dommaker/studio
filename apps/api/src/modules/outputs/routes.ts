// 产出文档 API - 存储和展示执行结果
import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { eventStore } from '../../core/event-store.js';
import { logger } from '../../utils/logger.js';
import { requireNotGuest, requireRole } from '../../middleware/auth.js';  // 🆕 SEC-001 / SEC-002

const router = Router();
const store = eventStore;

// 产出文档存储目录：环境变量 → 本地 .harness/outputs/
const OUTPUTS_DIR = process.env.OUTPUTS_DIR
  || path.join(process.cwd(), '.harness', 'outputs');

// 确保输出目录存在
function ensureOutputDir(executionId: string): string {
  const dir = path.join(OUTPUTS_DIR, executionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// 保存产出文档
export async function saveOutput(
  executionId: string,
  stepId: string,
  content: string,
  filename?: string
): Promise<{ path: string; filename: string }> {
  const dir = ensureOutputDir(executionId);
  const outputFilename = filename || `${stepId}-${Date.now()}.md`;
  const outputPath = path.join(dir, outputFilename);
  
  fs.writeFileSync(outputPath, content, 'utf-8');
  
  // 更新索引
  const key = `outputs:${executionId}`;
  await store.hset(key, outputFilename, JSON.stringify({
    filename: outputFilename,
    stepId,
    size: content.length,
    createdAt: new Date().toISOString(),
  }));
  
  logger.info('Output saved');
  
  return { path: outputPath, filename: outputFilename };
}

// 获取执行的所有产出文档
router.get('/:executionId', async (req, res) => {
  try {
    const { executionId } = req.params;
    const key = `outputs:${executionId}`;
    
    // 从 EventStore 获取索引
    const outputs = await store.hgetall(key);
    
    if (Object.keys(outputs).length === 0) {
      // 尝试从文件系统读取
      const dir = path.join(OUTPUTS_DIR, executionId);
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        const result = files.map(filename => {
          const filePath = path.join(dir, filename);
          const stat = fs.statSync(filePath);
          return {
            filename,
            size: stat.size,
            createdAt: stat.mtime.toISOString(),
            path: filePath,
          };
        });
        res.json({ executionId, outputs: result });
        return;
      }
      
      res.json({ executionId, outputs: [] });
      return;
    }
    
    // 解析缓存数据
    const result = Object.values(outputs).map((data: string) => JSON.parse(data));
    res.json({ executionId, outputs: result });
  } catch (error) {
    logger.error({ error }, 'Failed to list outputs');
    res.status(500).json({ error: 'Failed to list outputs' });
  }
});

// 获取单个产出文档内容
router.get('/:executionId/:filename', async (req, res) => {
  try {
    const { executionId, filename } = req.params;
    const filePath = path.join(OUTPUTS_DIR, executionId, filename);
    
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Output file not found' });
      return;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const stat = fs.statSync(filePath);
    
    // 根据文件扩展名设置 Content-Type
    const ext = path.extname(filename).toLowerCase();
    const contentTypes: Record<string, string> = {
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.html': 'text/html',
      '.yaml': 'text/yaml',
      '.yml': 'text/yaml',
    };
    
    const contentType = contentTypes[ext] || 'text/plain';
    
    res.setHeader('Content-Type', contentType);
    res.json({
      filename,
      executionId,
      content,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      contentType,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get output');
    res.status(500).json({ error: 'Failed to get output' });
  }
});

// 删除执行的所有产出文档
// 🆕 SEC-002: Admin only
router.delete('/:executionId', requireRole('Admin'), async (req, res) => {
  try {
    const { executionId } = req.params;
    const dir = path.join(OUTPUTS_DIR, executionId);
    
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true });
    }
    
    // 清除索引
    await store.del(`outputs:${executionId}`);
    
    res.json({ success: true, message: 'Outputs deleted' });
  } catch (error) {
    logger.error({ error }, 'Failed to delete outputs');
    res.status(500).json({ error: 'Failed to delete outputs' });
  }
});

export { router };
export default router;
