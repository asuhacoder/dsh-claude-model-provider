import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
/** Internal MCP payload; DSH 0.2 supplies first-class tool-role messages. */
export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: ToolCallId
  content: readonly ContentBlock[]
  isError?: boolean
}
