// Only the transport envelope. Request IDs correlate responses; they are not event IDs.
export function decodeEnvelope(input: Uint8Array): { type: number; requestId?: number; name: string; data: Uint8Array } {
  let offset = 0;
  const type = input[offset++];
  if (type !== 1 && type !== 2 && type !== 3) throw new Error('UNKNOWN_FRAME_TYPE');
  const requestId = type === 1 ? undefined : (input[offset++] ?? -65536) + (input[offset++] ?? -256) * 256;
  if (requestId !== undefined && requestId < 0) throw new Error('TRUNCATED_FRAME');
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = input[offset++];
      if (b === undefined) throw new Error('TRUNCATED_VARINT');
      value += (b & 127) * 2 ** shift;
      if (!(b & 128)) return value;
    }
    throw new Error('INVALID_VARINT');
  };
  let name = '', data = new Uint8Array();
  while (offset < input.length) {
    const key = varint();
    if ((key & 7) !== 2) throw new Error('UNEXPECTED_WRAPPER_FIELD');
    const length = varint(), end = offset + length;
    if (end > input.length) throw new Error('TRUNCATED_WRAPPER');
    if ((key >> 3) === 1) name = new TextDecoder('utf-8', { fatal: true }).decode(input.subarray(offset, end));
    if ((key >> 3) === 2) data = input.slice(offset, end);
    offset = end;
  }
  return { type, ...(requestId === undefined ? {} : { requestId }), name, data };
}
