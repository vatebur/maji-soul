import type { ModelConfig } from '../../schemas/config.ts';

// Provider text and HTTP error bodies must never enter diagnostic reports.
export async function probeCompletion(config: ModelConfig, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, stream: false,
      messages: [{ role: 'user', content: 'Return only the JSON object {"actionId":"probe-discard"}.' }],
      ...(config.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
      ...(config.responseFormat === 'json_schema' ? { response_format: { type: 'json_schema', json_schema: {
        name: 'probe', strict: true, schema: { type: 'object', properties: { actionId: { type: 'string', enum: ['probe-discard'] } },
          required: ['actionId'], additionalProperties: false } } } } : {}) })
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`MODEL_HTTP_${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_MODEL_ENVELOPE');
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65536) { await reader.cancel(); throw new Error('MODEL_RESPONSE_TOO_LARGE'); }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let envelope: { choices?: { message?: { content?: string } }[] };
  try { envelope = JSON.parse(raw); } catch { throw new Error('INVALID_MODEL_ENVELOPE'); }
  const content = envelope.choices?.[0]?.message?.content;
  let result: unknown;
  try { result = JSON.parse(content ?? ''); } catch { throw new Error('INVALID_MODEL_JSON'); }
  if (!result || typeof result !== 'object' || Object.keys(result).length !== 1 ||
    !('actionId' in result) || result.actionId !== 'probe-discard') throw new Error('INVALID_MODEL_ACTION');
}
