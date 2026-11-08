import type { ModelConfig } from '../../schemas/config.ts';

export interface JsonCompletionRequest {
  messages: { role: 'system' | 'user'; content: string }[];
  name: string;
  schema: object;
}

// Provider text and HTTP error bodies must never enter diagnostic reports.
export async function completeJson(config: ModelConfig, request: JsonCompletionRequest, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const body = JSON.stringify({ model: config.model, stream: false, messages: request.messages,
    ...(config.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
    ...(config.responseFormat === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: {
      name: request.name, strict: true, schema: request.schema } } } : {}) });
  if (Buffer.byteLength(body) > 262144) throw new Error('INVALID_MODEL_INPUT_SIZE');
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    redirect: 'error',
    method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body,
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`MODEL_HTTP_${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_MODEL_ENVELOPE');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) { await reader.cancel(); throw new Error('MODEL_RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal?.throwIfAborted();
  const raw = Buffer.concat(chunks).toString('utf8');
  let envelope: { choices?: { message?: { content?: string } }[] };
  try { envelope = JSON.parse(raw); } catch { throw new Error('INVALID_MODEL_ENVELOPE'); }
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('INVALID_MODEL_ENVELOPE');
  try { return JSON.parse(content ?? ''); } catch { throw new Error('INVALID_MODEL_JSON'); }
}

export async function probeCompletion(config: ModelConfig, signal?: AbortSignal): Promise<void> {
  const result = await completeJson(config, {
    name: 'probe',
    messages: [{ role: 'user', content: 'Return only the JSON object {"actionId":"probe-discard"}.' }],
    schema: { type: 'object', properties: { actionId: { type: 'string', enum: ['probe-discard'] } },
      required: ['actionId'], additionalProperties: false },
  }, signal);
  if (!result || typeof result !== 'object' || Object.keys(result).length !== 1 ||
    !('actionId' in result) || result.actionId !== 'probe-discard') throw new Error('INVALID_MODEL_ACTION');
}
