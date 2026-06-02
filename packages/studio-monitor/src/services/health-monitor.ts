// Health Monitor - Agent 健康监控
import { taskQueue } from '@dommaker/studio-task';
import { logger, memoryStore, eventBus } from '@dommaker/studio-shared';

export interface HealthMonitorConfig {
  taskTimeout?: number;      // 任务超时时间（毫秒），默认 60 分钟
  heartbeatTimeout?: number; // 心跳超时时间（毫秒），默认 10 分钟
  checkInterval?: number;    // 检查间隔（毫秒），默认 1 分钟
  zombieCheckInterval?: number; // 僵尸任务检查间隔，默认 5 分钟
}

export interface TaskHealth {
  taskId: string;
  status: 'healthy' | 'timeout' | 'idle' | 'zombie' | 'crashed';
  lastUpdate: Date;
  runningTime: number;
  message?: string;
}

export class HealthMonitor {
  private config: Required<HealthMonitorConfig>;
  private running = false;
  private intervals: NodeJS.Timeout[] = [];

  constructor(config: HealthMonitorConfig = {}) {
    this.config = {
      taskTimeout: config.taskTimeout || 60 * 60 * 1000,      // 60 分钟
      heartbeatTimeout: config.heartbeatTimeout || 10 * 60 * 1000, // 10 分钟
      checkInterval: config.checkInterval || 60 * 1000,       // 1 分钟
      zombieCheckInterval: config.zombieCheckInterval || 5 * 60 * 1000, // 5 分钟
    };
  }

  /**
   * 启动健康监控
   */
  async start(): Promise<void> {
    if (this.running) return;
    
    this.running = true;
    logger.info('Health monitor started', { config: this.config });

    // 定时检查运行中任务
    const checkInterval = setInterval(() => this.checkRunningTasks(), this.config.checkInterval);
    this.intervals.push(checkInterval);

    // 定时检查僵尸任务
    const zombieInterval = setInterval(() => this.checkZombieTasks(), this.config.zombieCheckInterval);
    this.intervals.push(zombieInterval);
  }

  /**
   * 停止健康监控
   */
  async stop(): Promise<void> {
    this.running = false;
    this.intervals.forEach(interval => clearInterval(interval));
    this.intervals = [];
    logger.info('Health monitor stopped');
  }

  /**
   * 检查运行中的任务
   */
  private async checkRunningTasks(): Promise<void> {
    try {
      const stats = await taskQueue.getStats();
      if (stats.running === 0) return;

      // 获取所有运行中的任务
      const runningTasks = await this.getRunningTasks();

      for (const task of runningTasks) {
        const health = await this.checkTaskHealth(task);
        
        if (health.status !== 'healthy') {
          await this.handleUnhealthyTask(health);
        }
      }
    } catch (error) {
      logger.error('Error checking running tasks', { error });
    }
  }

  /**
   * 检查僵尸任务（状态不一致）
   */
  private async checkZombieTasks(): Promise<void> {
    try {
      // 检查 MemoryStore 队列与实际进程的一致性
      const runningTasks = await this.getRunningTasks();
      
      for (const task of runningTasks) {
        // 检查任务是否有对应的活跃进程
        const hasProcess = await this.checkActiveProcess(task.id);
        
        if (!hasProcess) {
          logger.warn('Zombie task detected - no active process', { taskId: task.id });
          await this.handleUnhealthyTask({
            taskId: task.id,
            status: 'zombie',
            lastUpdate: new Date(task.startedAt || Date.now()),
            runningTime: Date.now() - new Date(task.startedAt || Date.now()).getTime(),
            message: '任务状态显示运行中，但没有对应的活跃进程',
          });
        }
      }
    } catch (error) {
      logger.error('Error checking zombie tasks', { error });
    }
  }

  /**
   * 检查单个任务健康状态
   */
  private async checkTaskHealth(task: any): Promise<TaskHealth> {
    const startedAt = task.startedAt ? new Date(task.startedAt) : new Date();
    const runningTime = Date.now() - startedAt.getTime();
    const lastUpdate = task.lastAttemptAt ? new Date(task.lastAttemptAt) : startedAt;

    // 超时检查
    if (runningTime > this.config.taskTimeout) {
      return {
        taskId: task.id,
        status: 'timeout',
        lastUpdate,
        runningTime,
        message: `任务运行超过 ${Math.round(runningTime / 60000)} 分钟`,
      };
    }

    // 心跳检查
    const idleTime = Date.now() - lastUpdate.getTime();
    if (idleTime > this.config.heartbeatTimeout) {
      return {
        taskId: task.id,
        status: 'idle',
        lastUpdate,
        runningTime,
        message: `任务超过 ${Math.round(idleTime / 60000)} 分钟无更新`,
      };
    }

    return {
      taskId: task.id,
      status: 'healthy',
      lastUpdate,
      runningTime,
    };
  }

  /**
   * 处理不健康的任务
   */
  private async handleUnhealthyTask(health: TaskHealth): Promise<void> {
    logger.warn('Unhealthy task detected', { health });

    switch (health.status) {
      case 'timeout':
        // 超时：标记失败并通知
        await taskQueue.failTask(health.taskId, health.message || '任务超时');
        await this.notifyHuman('timeout', health);
        break;

      case 'idle':
        // 空闲：发送告警，但不中断
        await this.notifyHuman('idle', health);
        break;

      case 'zombie':
        // 僵尸：标记失败
        await taskQueue.failTask(health.taskId, health.message || '僵尸任务');
        await this.notifyHuman('zombie', health);
        break;

      case 'crashed':
        // 崩溃：标记失败并通知
        await taskQueue.failTask(health.taskId, health.message || 'Agent 崩溃');
        await this.notifyHuman('crash', health);
        break;
    }
  }

  /**
   * 获取运行中的任务
   */
  private async getRunningTasks(): Promise<any[]> {
    // MemoryStore: use keys with prefix pattern to find running tasks
    const keys = await memoryStore.keys('task:');
    const tasks = [];

    for (const key of keys) {
      const data = await memoryStore.get(key);
      if (data) {
        try { tasks.push(JSON.parse(data)); } catch { tasks.push(data); }
      }
    }

    return tasks;
  }

  /**
   * 检查任务是否有对应的活跃进程
   */
  private async checkActiveProcess(taskId: string): Promise<boolean> {
    // 检查心跳记录来判断进程是否活跃
    const lastHeartbeat = await memoryStore.get(`task:heartbeat:${taskId}`);
    if (!lastHeartbeat) return false;

    const heartbeatTime = parseInt(lastHeartbeat, 10);
    const idleTime = Date.now() - heartbeatTime;

    // 如果心跳在 5 分钟内，认为进程活跃
    return idleTime < 5 * 60 * 1000;
  }

  /**
   * 更新任务心跳
   */
  async updateHeartbeat(taskId: string): Promise<void> {
    await memoryStore.set(`task:heartbeat:${taskId}`, Date.now().toString());
  }

  /**
   * 发送人工通知
   */
  private async notifyHuman(type: string, health: TaskHealth): Promise<void> {
    const messages: Record<string, string> = {
      timeout: `⏰ **任务超时**\n任务 ${health.taskId} 运行超过 ${Math.round(health.runningTime / 60000)} 分钟`,
      idle: `⚠️ **任务空闲**\n任务 ${health.taskId} 超过 ${Math.round((Date.now() - health.lastUpdate.getTime()) / 60000)} 分钟无更新`,
      zombie: `🧟 **僵尸任务**\n任务 ${health.taskId} 状态异常，可能需要人工干预`,
      crash: `💥 **Agent 崩溃**\n任务 ${health.taskId} 的 Agent 意外退出`,
    };

    const content = messages[type] || `❓ 任务 ${health.taskId} 状态异常`;

    // 发布到通知频道
    eventBus.publish('notifications', {
      type: 'human-intervention',
      taskId: health.taskId,
      status: health.status,
      message: content,
      timestamp: new Date().toISOString(),
    });

    logger.info('Human notification sent', { type, taskId: health.taskId });
  }

  /**
   * 获取监控状态
   */
  getStatus(): {
    running: boolean;
    config: Required<HealthMonitorConfig>;
    intervals: number;
  } {
    return {
      running: this.running,
      config: this.config,
      intervals: this.intervals.length,
    };
  }
}

// 单例实例
let healthMonitorInstance: HealthMonitor | null = null;

export function getHealthMonitor(): HealthMonitor {
  if (!healthMonitorInstance) {
    healthMonitorInstance = new HealthMonitor();
  }
  return healthMonitorInstance;
}

export async function startHealthMonitor(): Promise<void> {
  const monitor = getHealthMonitor();
  await monitor.start();
}

export async function stopHealthMonitor(): Promise<void> {
  if (healthMonitorInstance) {
    await healthMonitorInstance.stop();
  }
}
