export interface AuditLog {
  id: string;
  companyId: string;
  action: string;
  actor: string;
  target: string;
  details: string;
  timestamp: Date;
}

export interface LogOptions {
  company: string;
  action?: string;
  limit?: number;
  format?: 'table' | 'json';
}

export interface ExportOptions {
  company: string;
  from: string;
  to: string;
  format?: 'csv' | 'json';
}

export interface SearchOptions {
  company: string;
  query: string;
  format?: 'table' | 'json';
}