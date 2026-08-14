# Resilient Bridge Ownership

## Problem

Each MCP process currently attempts to own the local Chrome-extension bridge. When the port is already occupied, that process permanently becomes a client of the existing owner. If the owner later exits, surviving and newly launched MCP clients continue calling the dead port and return `ECONNREFUSED`. Agents then have to start an unrelated project script manually, which is not portable and can leave orphan processes.

## Chosen Design

Use cooperative, in-process bridge ownership with automatic failover:

1. Every MCP process uses the same resilient router abstraction.
2. At startup it first checks the configured bridge health endpoint.
3. If no healthy bridge exists, it attempts to start the plugin's own `src/bridge-server.mjs`.
4. Concurrent starters are safe: one becomes owner; processes receiving `EADDRINUSE` wait for and connect to the winner.
5. If a later request fails with a transport error such as `ECONNREFUSED`, `ECONNRESET`, or `EPIPE`, the router runs the same election once and retries the request once.
6. After bridge recovery, a profile-scoped request waits briefly for the installed extension to re-register before retrying.
7. On MCP shutdown, a process closes only a bridge instance that it owns. Other clients recover on their next request.

The bridge remains local, authenticated by the existing secret, and embedded in the plugin. No Windows service, scheduled task, detached project process, remote-debugging port, copied Chrome data, or project-specific script is introduced.

## Error Boundary

Only connection and socket failures trigger ownership recovery. Profile mismatch, missing profile, extension command timeout, page-contract failures, account errors, and platform errors remain fail-closed and are never retried as bridge failures.

## Tests

- Initial client connects to an existing healthy bridge without starting another.
- Empty-port startup elects one owner.
- Concurrent `EADDRINUSE` waits for the winning server.
- A client request recovering from `ECONNREFUSED` elects a new owner and retries once.
- Non-transport errors do not trigger recovery.
- Concurrent failed requests share one recovery attempt.
- Shutdown closes only the locally owned bridge.
- Existing plugin unit, parity, and live two-profile acceptance suites remain green.

## Acceptance

Start two independent MCP clients, terminate the current bridge owner, and prove the remaining/new client automatically restores the bridge, sees both exact profile registrations, passes `chrome_selftest`, and performs repeated calls without `ECONNREFUSED`. No external project file may be required by the plugin runtime.
