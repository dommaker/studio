// Trigger Store — YAML-based trigger config persistence (3.28c-4)
// Location: ~/.studio/triggers/*.yaml
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { CronMatcher } from './cron-matcher.js';
import type { TriggerConfig } from './trigger.types.js';

/** Validate a trigger config has required fields */
function validateTrigger(config: TriggerConfig): void {
  if (!config.id || typeof config.id !== 'string') {
    throw new Error('Trigger must have an id');
  }
  if (!config.name || typeof config.name !== 'string') {
    throw new Error('Trigger must have a name');
  }
  if (!config.condition || config.condition.type !== 'SCHEDULE' || !config.condition.cron) {
    throw new Error('Trigger must have a SCHEDULE condition with cron');
  }
  if (!CronMatcher.isValid(config.condition.cron)) {
    throw new Error(`Invalid cron expression: "${config.condition.cron}"`);
  }
  if (!config.action || config.action.type !== 'CREATE' || !config.action.target) {
    throw new Error('Trigger must have a CREATE action with target');
  }
  if (!config.action.payload || !config.action.payload.type || !config.action.payload.scope) {
    throw new Error('Trigger action must have payload with type and scope');
  }
  if (typeof config.enabled !== 'boolean') {
    throw new Error('Trigger must have enabled (boolean)');
  }
  if (!config.scope || typeof config.scope !== 'string') {
    throw new Error('Trigger must have a scope');
  }
}

export class TriggerStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir || path.join(process.env.HOME || '~', '.studio', 'triggers');
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  /** List all triggers */
  list(): TriggerConfig[] {
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    const triggers: TriggerConfig[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.dir, file), 'utf-8');
        const parsed = yaml.load(content) as TriggerConfig;
        if (parsed && parsed.id) {
          triggers.push(parsed);
        }
      } catch {
        // Skip malformed files
      }
    }

    return triggers;
  }

  /** Get a single trigger by id */
  get(id: string): TriggerConfig | undefined {
    return this.list().find(t => t.id === id);
  }

  /** Save a trigger (creates or updates) */
  save(config: TriggerConfig): void {
    validateTrigger(config);
    const filePath = path.join(this.dir, `${config.id}.yaml`);
    const content = yaml.dump(config, { indent: 2, lineWidth: 120 });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  /** Delete a trigger by id */
  delete(id: string): boolean {
    const filePath = path.join(this.dir, `${id}.yaml`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }
}
