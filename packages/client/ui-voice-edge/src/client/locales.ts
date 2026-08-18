/** `voiceEdge` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'user.aria': '镜像的用户消息',
  'assistant.aria': '镜像的助手回复',
  'reasoning.label': '思考过程',
  'tool.aria': 'Harness 工具调用',
  'tool.running': '执行中',
  'tool.succeeded': '完成',
  'tool.failed': '失败',
} satisfies Record<string, string>

/** The voiceEdge namespace key union. */
export type VoiceEdgeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'user.aria': 'Mirrored user message',
  'assistant.aria': 'Mirrored assistant reply',
  'reasoning.label': 'Reasoning',
  'tool.aria': 'Harness tool call',
  'tool.running': 'Running',
  'tool.succeeded': 'Completed',
  'tool.failed': 'Failed',
} satisfies Record<VoiceEdgeKey, string>
