// studio-spec 入口

export { SpecValidatorService, ArchitectureValidator, ApiValidator, AcceptanceValidator } from './services/spec-validator.service.js';
export { ChangeAnalyzerService, changeAnalyzerService } from './services/change-analyzer.service.js';
export { ChangeHistoryService, changeHistoryService } from './services/change-history.service.js';
export { GateCheckerService, gateCheckerService } from './services/gate-checker.service.js';

export type {
  ValidateSpecInput,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  LayerResult,
  ValidationLayer,
  SpecContent,
} from './types/validation.types.js';

export type {
  FailureLevel,
  ChangeLevel,
  ChangeType,
  AnalyzeChangeInput,
  AnalyzeChangeResult,
  ChangeDetail,
  ApprovalProcess,
  ChangeRecord,
} from './types/change.types.js';

export type {
  CheckpointType,
  CheckResult,
  ValidateChangeInput,
  ValidateChangeResult,
  GatePolicy,
  HarnessCheckConfig,
  CheckConfig,
} from './types/gate.types.js';

export { isHarnessCheck, HARNESS_CHECK_TYPES } from './types/gate.types.js';
