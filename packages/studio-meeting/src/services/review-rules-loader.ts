/**
 * 评审规则配置加载器
 */

import { readFileSync } from 'fs';
import * as yaml from 'yaml';
import * as path from 'path';

export interface ReviewRules {
  review: {
    initiator: {
      type: 'any_developer' | 'role_based';
      allowed_roles?: string[];
    };
    max_concurrent_per_user: number;
  };
  
  required_participants: Record<string, {
    high: string[];
    medium: string[];
    low: string[];
  }>;
  
  approval: {
    mode: 'majority_2_3' | 'simple_majority' | 'unanimous';
    min_approvers: number;
    max_rejecters: number;
    architect: {
      required_approval: boolean;
      can_veto: boolean;
      veto_overrides: boolean;
    };
  };
  
  timeout: {
    per_person: {
      duration: string;
      reminder_at: string;
    };
    total: {
      duration: string;
      action_on_timeout: 'close' | 'escalate' | 'auto_approve';
    };
    business_hours: {
      enabled: boolean;
      timezone: string;
      work_hours: [number, number];
      work_days: number[];
    };
  };
  
  auto_actions: {
    all_responded: {
      action: 'finalize' | 'wait';
      finalize_delay: string;
    };
    threshold_reached: {
      action: 'finalize' | 'wait';
      finalize_delay: string;
    };
    rejected: {
      action: 'notify_author' | 'immediately_close';
      grace_period: string;
    };
    timeout: {
      action: 'close' | 'escalate' | 'auto_approve';
      escalate_to?: string[];
    };
  };
  
  checklist: Record<string, string[]>;
  notifications: Record<string, Record<string, string>>;
}

let cachedRules: ReviewRules | null = null;
let cachedAt: number = 0;
const CACHE_TTL = 60000; // 1分钟缓存

/**
 * 加载评审规则
 */
export function loadReviewRules(configPath?: string): ReviewRules {
  const now = Date.now();
  
  // 使用缓存
  if (cachedRules && now - cachedAt < CACHE_TTL) {
    return cachedRules;
  }
  
  const filePath = configPath || path.join(process.cwd(), '.architect', 'review-rules.yml');
  
  try {
    const content = readFileSync(filePath, 'utf-8');
    const rules = yaml.parse(content) as ReviewRules;
    
    // 验证规则完整性
    validateRules(rules);
    
    cachedRules = rules;
    cachedAt = now;
    
    return rules;
  } catch (error) {
    console.warn('Failed to load review rules, using defaults:', error);
    return getDefaultRules();
  }
}

/**
 * 获取强制参与者
 */
export function getRequiredParticipants(
  rules: ReviewRules,
  changeType: string,
  impact: string
): string[] {
  const rule = rules.required_participants[changeType] 
               || rules.required_participants.default;
  
  return rule[impact as keyof typeof rule] || rule.medium;
}

/**
 * 计算评审结果
 */
export function calculateVerdict(
  rules: ReviewRules,
  votes: Array<{ role: string; response: 'approve' | 'reject' | 'abstain' }>
): {
  status: 'approved' | 'rejected' | 'pending';
  reason?: string;
  approve_count: number;
  reject_count: number;
} {
  const config = rules.approval;
  
  // 检查架构师否决
  if (config.architect.can_veto) {
    const architectVeto = votes.find(v => 
      v.role === 'architect' && v.response === 'reject'
    );
    if (architectVeto) {
      return {
        status: 'rejected',
        reason: 'architect_veto',
        approve_count: votes.filter(v => v.response === 'approve').length,
        reject_count: votes.filter(v => v.response === 'reject').length,
      };
    }
  }
  
  // 检查最大拒绝数
  const rejectCount = votes.filter(v => v.response === 'reject').length;
  if (rejectCount >= config.max_rejecters) {
    return {
      status: 'rejected',
      reason: 'max_rejecters_reached',
      approve_count: votes.filter(v => v.response === 'approve').length,
      reject_count: rejectCount,
    };
  }
  
  // 计算通过
  const approveCount = votes.filter(v => v.response === 'approve').length;
  const totalVotes = votes.length;
  
  let passed = false;
  switch (config.mode) {
    case 'majority_2_3':
      passed = approveCount >= Math.ceil(totalVotes * 2 / 3);
      break;
    case 'simple_majority':
      passed = approveCount > totalVotes / 2;
      break;
    case 'unanimous':
      passed = approveCount === totalVotes;
      break;
  }
  
  // 检查最小批准人数
  if (approveCount < config.min_approvers) {
    passed = false;
  }
  
  // 检查必须有架构师批准
  if (config.architect.required_approval) {
    const architectApproved = votes.some(v =>
      v.role === 'architect' && v.response === 'approve'
    );
    if (!architectApproved) {
      passed = false;
    }
  }
  
  return {
    status: passed ? 'approved' : 'pending',
    approve_count: approveCount,
    reject_count: rejectCount,
  };
}

/**
 * 计算业务时间（时区安全版本）
 *
 * 迭代逻辑基于目标时区的日期边界，而非服务器本地时间。
 */
export function calculateBusinessHours(
  rules: ReviewRules,
  startTime: Date,
  endTime: Date
): number {
  const config = rules.timeout.business_hours;

  if (!config.enabled) {
    return (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60);
  }

  const timezone = config.timezone || 'Asia/Shanghai';
  const workStart = config.work_hours[0];
  const workEnd = config.work_hours[1];
  const workDays = new Set(config.work_days);
  const hoursPerDay = workEnd - workStart;

  // 获取指定 timezone 的日期部分
  const getDateParts = (date: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');
    return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour') };
  };

  // 生成时区日期的 YYYY-MM-DD 字符串（用于比较）
  const toDateString = (date: Date) => {
    const p = getDateParts(date);
    return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  };

  const startParts = getDateParts(startTime);
  const endParts = getDateParts(endTime);
  const startDayStr = toDateString(startTime);
  const endDayStr = toDateString(endTime);

  // 按天迭代（基于时区日期边界）
  let totalHours = 0;
  let currentDayStr = startDayStr;

  while (currentDayStr <= endDayStr) {
    // 解析当前日期的星期
    const [y, m, d] = currentDayStr.split('-').map(Number);
    const dayOfWeek = new Date(y, m - 1, d).getDay();

    if (workDays.has(dayOfWeek)) {
      const isStartDay = currentDayStr === startDayStr;
      const isEndDay = currentDayStr === endDayStr;

      if (isStartDay && isEndDay) {
        const hStart = Math.max(startParts.hour, workStart);
        const hEnd = Math.min(endParts.hour, workEnd);
        totalHours += Math.max(0, hEnd - hStart);
      } else if (isStartDay) {
        totalHours += Math.max(0, workEnd - Math.max(startParts.hour, workStart));
      } else if (isEndDay) {
        totalHours += Math.max(0, Math.min(endParts.hour, workEnd) - workStart);
      } else {
        totalHours += hoursPerDay;
      }
    }

    // 前进一天（基于时区日期字符串）
    const nextDate = new Date(y, m - 1, d + 1);
    currentDayStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
  }

  return totalHours;
}

/**
 * 解析时间字符串（如 "24h"）
 */
export function parseDuration(durationStr: string): number {
  const match = durationStr.match(/^(\d+)(h|d)$/);
  if (!match) return 24;
  
  const value = parseInt(match[1], 10);
  const unit = match[2];
  
  if (unit === 'd') return value * 24;
  return value;
}

/**
 * 验证规则配置
 */
function validateRules(rules: ReviewRules): void {
  // 确保关键字段存在
  if (!rules.approval) {
    throw new Error('Missing approval configuration');
  }
  if (!rules.timeout) {
    throw new Error('Missing timeout configuration');
  }
}

/**
 * 默认规则
 */
function getDefaultRules(): ReviewRules {
  return {
    review: {
      initiator: { type: 'any_developer' },
      max_concurrent_per_user: 3,
    },
    required_participants: {
      default: {
        high: ['architect', 'tech_lead'],
        medium: ['architect'],
        low: ['tech_lead'],
      },
    },
    approval: {
      mode: 'majority_2_3',
      min_approvers: 2,
      max_rejecters: 1,
      architect: {
        required_approval: true,
        can_veto: true,
        veto_overrides: false,
      },
    },
    timeout: {
      per_person: {
        duration: '24h',
        reminder_at: '18h',
      },
      total: {
        duration: '72h',
        action_on_timeout: 'escalate',
      },
      business_hours: {
        enabled: true,
        timezone: 'Asia/Shanghai',
        work_hours: [9, 18],
        work_days: [1, 2, 3, 4, 5],
      },
    },
    auto_actions: {
      all_responded: {
        action: 'finalize',
        finalize_delay: '0h',
      },
      threshold_reached: {
        action: 'finalize',
        finalize_delay: '4h',
      },
      rejected: {
        action: 'notify_author',
        grace_period: '24h',
      },
      timeout: {
        action: 'escalate',
        escalate_to: ['cto'],
      },
    },
    checklist: {},
    notifications: {},
  };
}

// 清除缓存（配置更新时调用）
export function clearRulesCache(): void {
  cachedRules = null;
  cachedAt = 0;
}
