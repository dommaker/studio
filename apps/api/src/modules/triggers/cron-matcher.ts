// Cron Matcher — minimal cron expression evaluator (3.28c-4)
// Supports: * , - / for each field: minute hour day-of-month month day-of-week
// Day of week: 0=Sunday, 1=Monday, ..., 6=Saturday

type FieldValues = Set<number>;

/** Parse a single cron field into a set of matching values */
function parseField(field: string, min: number, max: number): FieldValues {
  const values = new Set<number>();

  for (const part of field.split(',')) {
    // Step: */n or range/n
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      if (step === 0) throw new Error(`Invalid step: ${part}`);
      const range = parseRange(stepMatch[1], min, max);
      for (let i = range.start; i <= range.end; i += step) {
        values.add(i);
      }
      continue;
    }

    // Range: a-b
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      validateValue(start, min, max);
      validateValue(end, min, max);
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
      continue;
    }

    // Wildcard
    if (part === '*') {
      for (let i = min; i <= max; i++) {
        values.add(i);
      }
      continue;
    }

    // Single value
    const val = parseInt(part, 10);
    validateValue(val, min, max);
    values.add(val);
  }

  return values;
}

function parseRange(expr: string, min: number, max: number): { start: number; end: number } {
  if (expr === '*') return { start: min, end: max };
  const val = parseInt(expr, 10);
  validateValue(val, min, max);
  return { start: val, end: max };
}

function validateValue(val: number, min: number, max: number): void {
  if (isNaN(val) || val < min || val > max) {
    throw new Error(`Value ${val} out of range [${min}-${max}]`);
  }
}

export class CronMatcher {
  private minutes: FieldValues;
  private hours: FieldValues;
  private daysOfMonth: FieldValues;
  private months: FieldValues;
  private daysOfWeek: FieldValues;
  private expression: string;

  constructor(expression: string) {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new Error(`Invalid cron expression: "${expression}" (expected 5 fields, got ${fields.length})`);
    }

    this.expression = expression;
    this.minutes = parseField(fields[0], 0, 59);
    this.hours = parseField(fields[1], 0, 23);
    this.daysOfMonth = parseField(fields[2], 1, 31);
    this.months = parseField(fields[3], 1, 12);
    this.daysOfWeek = parseField(fields[4], 0, 6);
  }

  /** Check if the given date matches this cron expression */
  matches(date: Date): boolean {
    return (
      this.minutes.has(date.getMinutes()) &&
      this.hours.has(date.getHours()) &&
      this.daysOfMonth.has(date.getDate()) &&
      this.months.has(date.getMonth() + 1) && // JS months are 0-based
      this.daysOfWeek.has(date.getDay()) // JS: 0=Sunday
    );
  }

  /** Validate a cron expression without creating an instance */
  static isValid(expression: string): boolean {
    try {
      new CronMatcher(expression);
      return true;
    } catch {
      return false;
    }
  }

  toString(): string {
    return this.expression;
  }
}
