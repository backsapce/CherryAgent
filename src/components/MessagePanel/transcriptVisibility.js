export function hasRenderableTranscript(transcript, toolCalls, streaming = false) {
  if (!Array.isArray(transcript) || transcript.length === 0) return false;
  const toolIds = new Set((toolCalls || []).map((toolCall) => toolCall?.id).filter(Boolean));

  return transcript.some((segment) => {
    if (!segment) return false;
    if (segment.type === 'tool') return toolIds.has(segment.toolCallId);
    if (String(segment.content || '').trim()) return true;
    return segment.type === 'reasoning'
      && streaming
      && segment.status !== 'finished';
  });
}
