import React from 'react';

interface ConversationActionsProps {
  channelId: string;
  onStartExecution?: () => void;
  onContinueDiscussion?: () => void;
}

export const ConversationActions: React.FC<ConversationActionsProps> = ({
  channelId,
  onStartExecution,
  onContinueDiscussion,
}) => {
  return (
    <div>
      <button onClick={onStartExecution}>Start Execution</button>
      <button onClick={onContinueDiscussion}>Continue Discussion</button>
    </div>
  );
};
