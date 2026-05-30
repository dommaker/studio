/**
 * User Behavior Profile types — KE-003
 *
 * 从 Claude Code 会话对话中提取的用户行为模式。
 * 三类信号：correction（纠正）、workflow（决策模式）、automation（重复操作）。
 */

export interface UserBehaviorProfile {
  id: string;
  sessionId: string;
  category: 'correction' | 'workflow' | 'automation';
  title: string;
  evidence: string;
  pattern: string;
  suggestedAction: 'create_rule' | 'create_skill' | 'create_automation' | 'skip';
  confidence: number;
  alreadyCovered?: string;
  status: 'pending' | 'confirmed' | 'rejected' | 'applied';
  createdAt: string;
  updatedAt: string;
}

export interface ExtractBehaviorInput {
  content: string; // Preprocessed transcript
  source: string;  // "session:<uuid>"
  threshold?: number; // Default 0.6
}

export interface ExtractBehaviorResult {
  profiles: UserBehaviorProfile[];
  existingPatterns: string[]; // Patterns injected for dedup
}
