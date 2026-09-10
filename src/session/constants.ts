/**
 * Provider-aware screenshot defaults — extracted verbatim from session.ts (PR-13b split).
 */

export const PROVIDER_WIDTH: Record<string, number> = {
  anthropic:     1024,
  openai:        1024,
  'openai-low':   512,
  gemini:         768,
  llama:         1120,
  grok:          1024,
  mistral:       1024,
  qwen:           896,
  nova:          1024,
  'deepseek-vl':  896,
  // DeepSeek Flash rescales every image to roughly the pixel count of 1300x1300
  // before inference and caps it at 1024 tokens, so a wider capture costs upload
  // bytes without buying the model any additional detail.
  'deepseek-flash': 1280,
  phi:            896,
  auto:          1024,
}

export const PROVIDER_QUALITY: Record<string, number> = {
  anthropic: 80,
  openai:    80,
  gemini:    75,
  default:   80,
}
