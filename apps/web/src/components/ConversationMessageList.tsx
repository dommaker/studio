import React from 'react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string | null;
  createdAt: string;
  thinking?: boolean;
}

interface ConversationMessageListProps {
  messages: Message[];
}

export const ConversationMessageList: React.FC<ConversationMessageListProps> = ({
  messages,
}) => {
  if (messages.length === 0) return <div>No messages</div>;

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          <span>{msg.role}</span>
          {msg.thinking ? (
            <span>Thinking...</span>
          ) : (
            <span>{msg.content}</span>
          )}
        </div>
      ))}
    </div>
  );
};
