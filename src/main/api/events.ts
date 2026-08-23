/**
 * The push half of the deck API.
 *
 * Request/response is only half of what the renderer consumes: pty output, session exits and status
 * changes arrive unsolicited. Those used to be written straight into `win.webContents`, which made the
 * local window the only possible destination — the same dead end the handler bodies were in.
 *
 * Handlers now publish to this hub and transports subscribe: the local IPC bridge forwards to the
 * window, and a remote link forwards to the machine that asked for that stream. Neither knows about
 * the other, and a handler knows about neither.
 */
export type EventSink = (channel: string, payload: unknown) => void;

export interface EventHub {
  publish(channel: string, payload: unknown): void;
  /** Returns an unsubscribe function — a disconnected remote viewer must stop receiving pty bytes. */
  subscribe(sink: EventSink): () => void;
  /** How many sinks are attached; a stream with no listener is worth not producing. */
  readonly sinkCount: number;
}

export function makeEventHub(): EventHub {
  const sinks = new Set<EventSink>();
  return {
    publish(channel, payload) {
      // Iterate a snapshot: a sink that unsubscribes (or is torn down) while being notified must not
      // disturb delivery to the others.
      for (const sink of [...sinks]) {
        // One failing destination — a window mid-teardown, a half-closed socket — must never unwind
        // the pty data callback that is publishing. That escape is what used to surface as an
        // uncaughtException from deep inside a stream handler.
        try { sink(channel, payload); } catch { /* a broken sink is that transport's problem */ }
      }
    },
    subscribe(sink) {
      sinks.add(sink);
      return () => { sinks.delete(sink); };
    },
    get sinkCount() { return sinks.size; },
  };
}
