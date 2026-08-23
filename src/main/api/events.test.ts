import { describe, it, expect, vi } from 'vitest';
import { makeEventHub } from './events';

describe('makeEventHub', () => {
  it('fans one publish out to every subscriber', () => {
    const hub = makeEventHub();
    const window = vi.fn();
    const remote = vi.fn();
    hub.subscribe(window);
    hub.subscribe(remote);
    hub.publish('cockpit:data', { id: 's1', chunk: 'hi' });
    expect(window).toHaveBeenCalledWith('cockpit:data', { id: 's1', chunk: 'hi' });
    expect(remote).toHaveBeenCalledWith('cockpit:data', { id: 's1', chunk: 'hi' });
  });

  it('stops delivering once a transport unsubscribes', () => {
    // A disconnected remote viewer must stop receiving pty bytes — otherwise every dropped link keeps
    // costing the host serialization work for output nobody is reading.
    const hub = makeEventHub();
    const remote = vi.fn();
    const off = hub.subscribe(remote);
    hub.publish('cockpit:data', 1);
    off();
    hub.publish('cockpit:data', 2);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(hub.sinkCount).toBe(0);
  });

  it('keeps delivering when one sink throws', () => {
    // publish() runs inside the pty data callback. A window torn down mid-send used to let that throw
    // escape as an uncaughtException and take the other sessions with it.
    const hub = makeEventHub();
    const healthy = vi.fn();
    hub.subscribe(() => { throw new Error('renderer gone'); });
    hub.subscribe(healthy);
    expect(() => hub.publish('cockpit:exit', { id: 's1' })).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('lets a sink unsubscribe from inside its own callback', () => {
    // A link that detects a dead socket while handling an event tears itself down right there;
    // iterating the live set would then skip the sink after it.
    const hub = makeEventHub();
    const later = vi.fn();
    const off = hub.subscribe(() => off());
    hub.subscribe(later);
    hub.publish('x', null);
    expect(later).toHaveBeenCalledOnce();
    expect(hub.sinkCount).toBe(1);
  });

  it('publishes to nobody without complaint', () => {
    const hub = makeEventHub();
    expect(hub.sinkCount).toBe(0);
    expect(() => hub.publish('cockpit:data', 'x')).not.toThrow();
  });
});
