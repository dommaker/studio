/**
 * 全局弹窗组件
 * - ExecutionResultModal
 * - ProjectDetailModal
 */
import { ExecutionResult } from './ExecutionResult';
import { ProjectDetail } from './ProjectDetail';
import type { Execution, ExecutionState } from '../types';

interface GlobalModalsProps {
  showResult: boolean;
  currentExecution: ExecutionState | null;
  onCloseResult: () => void;
  selectedProject: any;
  onCloseProject: () => void;
}

export function GlobalModals({
  showResult,
  currentExecution,
  onCloseResult,
  selectedProject,
  onCloseProject,
}: GlobalModalsProps) {
  return (
    <>
      {showResult && currentExecution && (
        <ExecutionResult execution={currentExecution as unknown as Execution} onClose={onCloseResult} />
      )}
      {selectedProject && (
        <ProjectDetail project={selectedProject} onClose={onCloseProject} />
      )}
    </>
  );
}
