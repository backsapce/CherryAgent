export function editUserMessageAndDiscardFollowing(messages, messageId, content) {
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  const message = messages[messageIndex];

  if (messageIndex === -1 || message?.role !== 'user') return null;

  const updatedMessage = { ...message, content };

  return {
    messageIndex,
    messages: [
      ...messages.slice(0, messageIndex),
      updatedMessage,
    ],
  };
}
