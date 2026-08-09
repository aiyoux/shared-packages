import { describe, expect, it, vi } from 'vitest';
import { startWatchSession } from './watchSession.js';

class MockWS {
  static OPEN = 1;
  static instances: MockWS[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    MockWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWS.OPEN;
      this.onopen?.();
      this.onmessage?.({
        data: JSON.stringify({
          type: 'watch.hello',
          v: 1,
          feature: 'watch',
          client_id: 'c1',
          ts: new Date().toISOString()
        })
      });
    });
  }
  send(s: string) {
    this.sent.push(s);
    const msg = JSON.parse(s);
    if (msg.type === 'watch.subscribe') {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({
            type: 'watch.subscribed',
            sub_id: 's1',
            root_id: msg.root_id,
            path: '/tmp',
            v: 1,
            feature: 'watch',
            ts: new Date().toISOString()
          })
        });
      });
    }
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('startWatchSession', () => {
  it('ensures root, subscribes, fires onChange on event_batch', async () => {
    MockWS.instances = [];
    const onChange = vi.fn();
    const statuses: string[] = [];
    const ensureRoot = vi.fn(async () => ({ root_id: 'root-1', path: '/tmp' }));

    const session = startWatchSession({
      baseUrl: 'http://127.0.0.1:8300',
      rootPath: '/tmp',
      ensureRoot,
      onChange,
      onStatus: (s) => statuses.push(s),
      debounceMs: 10,
      WebSocketImpl: MockWS as unknown as typeof WebSocket
    });

    await vi.waitFor(() => expect(ensureRoot).toHaveBeenCalled());
    await vi.waitFor(() => MockWS.instances.length === 1);
    const ws = MockWS.instances[0]!;
    await vi.waitFor(() =>
      ws.sent.some((s) => JSON.parse(s).type === 'watch.subscribe')
    );
    await vi.waitFor(() => statuses.includes('subscribed'));

    onChange.mockClear();
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'watch.event_batch',
        sub_id: 's1',
        seq: 1,
        events: [{ kind: 'create', path: '/tmp/x', rel_path: 'x', is_dir: false }],
        v: 1,
        feature: 'watch',
        ts: new Date().toISOString()
      })
    });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(ws.sent.some((s) => JSON.parse(s).type === 'watch.ack')).toBe(true);

    session.stop();
    expect(session.getStatus()).toBe('closed');
  });
});
