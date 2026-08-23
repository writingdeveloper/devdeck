/**
 * The DeckApi method table: what the renderer (and, once DevDeck Link exists, a PAIRED REMOTE MACHINE)
 * can ask this process to do.
 *
 * Before this existed, every handler body lived inline inside `ipcMain.handle(...)` in ipc.ts, which
 * bound the app's whole capability surface to one transport. Remoting a session means running the SAME
 * function for a remote caller — not maintaining a second implementation — so the bodies moved into a
 * plain table and `ipc.ts` became one of its adapters.
 *
 * Every method also declares whether it may cross the network at all. That declaration lives HERE,
 * next to the handler, rather than in a list the link layer keeps separately: a list maintained apart
 * from the handlers is a list that goes stale the first time someone adds a channel.
 */

// Granted per device on the host; both ends need the vocabulary, so it lives in shared/.
export type { LinkPermission } from '../../shared/link/permissions';
import type { LinkPermission } from '../../shared/link/permissions';

export type RemotePolicy =
  /** Callable by a paired device that holds `permission`. */
  | { readonly remote: 'allow'; readonly permission: LinkPermission }
  /**
   * Never routed to another machine — not because it is dangerous, but because it is MEANINGLESS
   * there: window controls, the viewer's own UI preferences, its clipboard, its tile list.
   */
  | { readonly remote: 'local' }
  /** Must never cross the network, whatever permissions a device holds. `reason` is the invariant. */
  | { readonly remote: 'blocked'; readonly reason: string };

export const allow = (permission: LinkPermission): RemotePolicy => ({ remote: 'allow', permission });
export const localOnly: RemotePolicy = { remote: 'local' };
export const blocked = (reason: string): RemotePolicy => ({ remote: 'blocked', reason });

/**
 * `invoke` = request/response (`ipcMain.handle`); `send` = fire-and-forget (`ipcMain.on`).
 * The distinction is preserved because it is a real behavioral difference: a `send` has no reply
 * channel, so the link layer must not wait for one.
 */
export type MethodChannel = 'invoke' | 'send';

// Handlers are heterogeneous by nature (this is an RPC surface, not one signature); the table is the
// boundary where that heterogeneity is contained.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MethodHandler = (...args: any[]) => unknown;

export interface ApiMethod {
  readonly channel: MethodChannel;
  readonly remote: RemotePolicy;
  readonly handler: MethodHandler;
}

export type DeckApi = Record<string, ApiMethod>;

/** Collects methods while the API is being built. */
export interface MethodTableBuilder {
  invoke(name: string, remote: RemotePolicy, handler: MethodHandler): void;
  send(name: string, remote: RemotePolicy, handler: MethodHandler): void;
  readonly table: DeckApi;
}

export function makeMethodTable(): MethodTableBuilder {
  const table: DeckApi = {};
  const define = (channel: MethodChannel) => (name: string, remote: RemotePolicy, handler: MethodHandler): void => {
    // A duplicate name would silently shadow the earlier handler and, worse, could downgrade its
    // remote policy. Fail loudly at startup instead.
    if (Object.prototype.hasOwnProperty.call(table, name)) {
      throw new Error(`DeckApi: duplicate method '${name}'`);
    }
    table[name] = { channel, remote, handler };
  };
  return { invoke: define('invoke'), send: define('send'), table };
}

/** True when a paired device holding `held` may call `method`. The single gate the link layer uses. */
export function mayCallRemotely(method: ApiMethod | undefined, held: readonly LinkPermission[]): boolean {
  if (!method) return false;
  if (method.remote.remote !== 'allow') return false;
  return held.includes(method.remote.permission);
}

/** Method names a remote device could ever reach, for display in the pairing/permission UI. */
export function remotableMethods(api: DeckApi): string[] {
  return Object.keys(api).filter((name) => api[name].remote.remote === 'allow').sort();
}
