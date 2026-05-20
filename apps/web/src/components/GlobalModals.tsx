/**
 * 全局弹窗组件
 * - ExecutionResultModal
 * - AgentRegistryModal
 * - ProjectDetailModal
 */
import { AgentRegistry } from './AgentRegistry';
import { ExecutionResult } from './ExecutionResult';
import { ProjectDetail } from './ProjectDetail';
import type { Execution, ExecutionState } from '../types';

interface GlobalModalsProps {
  showResult: boolean;
  currentExecution: ExecutionState | null;
  onCloseResult: () => void;
  showAgentRegistry: boolean;
  onCloseAgentRegistry: () => void;
  selectedProject: any;
  onCloseProject: () => void;
}

export function GlobalModals({
  showResult,
  currentExecution,
  onCloseResult,
  showAgentRegistry,
  onCloseAgentRegistry,
  selectedProject,
  onCloseProject,
}: GlobalModalsProps) {
  return (
    <>
      {showResult && currentExecution && (
        <ExecutionResult execution={currentExecution as unknown as Execution} onClose={onCloseResult} />
      )}
      {showAgentRegistry && (
        <AgentRegistry onClose={onCloseAgentRegistry} />
      )}
      {selectedProject && (
        <ProjectDetail project={selectedProject} onClose={onCloseProject} />
      )}
    </>
  );
}
