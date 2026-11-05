export interface ModelConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  responseFormat: 'none' | 'json_object' | 'json_schema';
  timeoutMs: number;
}

export function modelConfig(env: NodeJS.ProcessEnv): ModelConfig {
  const { MAJI_AI_BASE_URL: baseUrl, MAJI_AI_MODEL: model, MAJI_AI_API_KEY: apiKey } = env;
  if (!baseUrl || !model || !apiKey) throw new Error('MODEL_NOT_CONFIGURED');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('INVALID_MODEL_URL');
  const responseFormat = env.MAJI_AI_RESPONSE_FORMAT ?? 'none';
  if (!['none', 'json_object', 'json_schema'].includes(responseFormat)) throw new Error('INVALID_RESPONSE_FORMAT');
  const timeoutMs = Number(env.MAJI_AI_TIMEOUT_MS ?? 15000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('INVALID_MODEL_TIMEOUT');
  return { baseUrl: baseUrl.replace(/\/$/, ''), model, apiKey,
    responseFormat: responseFormat as ModelConfig['responseFormat'], timeoutMs };
}
