// Run this function with ego Page.evaluate(). Never stores payloads, cookies or URLs.
export function installMetadataProbe() {
  if (window.__majiProbe) window.__majiProbe.restore();
  const original = WebSocket.prototype.send;
  const sockets = new Map();
  let sent = 0, received = 0, closed = 0, errors = 0, sequence = 0, dropped = 0;
  const entries = [];
  function record(direction, raw) {
    const b = raw instanceof ArrayBuffer ? new Uint8Array(raw) : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : null;
    if (!b) return;
    let i = b[0] === 1 ? 1 : 3;
    let name = '';
    if (b[i++] === 10) {
      let length = 0, shift = 0, byte;
      do { byte = b[i++]; if (byte === undefined || shift > 28) return; length += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
      if (length <= 160 && i + length <= b.length) name = new TextDecoder().decode(b.subarray(i,i+length));
    }
    if (!/^\.lq\.[A-Za-z0-9_.]*$/.test(name)) name = '';
    entries.push({ sequence: ++sequence, direction, type: b[0], size: b.length, method: name });
    if (entries.length > 256) { entries.shift(); dropped++; }
  }
  function attach(socket) {
    if (sockets.has(socket)) return;
    const onmessage = e => { received++; record('in', e.data); };
    const onclose = () => { closed++; };
    const onerror = () => { errors++; };
    socket.addEventListener('message', onmessage); socket.addEventListener('close',onclose); socket.addEventListener('error',onerror);
    sockets.set(socket, {onmessage,onclose,onerror});
  }
  const send = function(data) { attach(this); sent++; record('out',data); return original.call(this,data); };
  WebSocket.prototype.send = send;
  window.__majiProbe = {
    read: () => ({ version: 1, clientVersion: window.__webglProductVersion, sent, received, closed, errors,
      sequence, dropped, sockets: sockets.size, entries: entries.slice(), payloadsRetained: false,
      reliableSourceCursor: false, finalSendFenceVerified: false }),
    restore: () => {
      if (WebSocket.prototype.send === send) WebSocket.prototype.send = original;
      for (const [socket,h] of sockets) { socket.removeEventListener('message',h.onmessage); socket.removeEventListener('close',h.onclose); socket.removeEventListener('error',h.onerror); }
      sockets.clear(); delete window.__majiProbe;
    }
  };
  return { installed: true, payloadsRetained: false };
}
