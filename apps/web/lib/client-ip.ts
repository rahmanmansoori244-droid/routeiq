/**
 * The caller's IP address, for rate limits and audit rows.
 *
 * The web app runs behind Railway's edge proxy, so the socket address is the proxy's, and the
 * client address comes from a header. The LEFT-most X-Forwarded-For entry is whatever the client
 * sent and must never be trusted: anyone can put any value there. A proxy APPENDS the address it
 * saw, so the trustworthy entry is counted from the right:
 *
 *   X-Forwarded-For: <client-supplied...>, <client as seen by proxy 1>, ..., <as seen by proxy N>
 *
 * - `TRUSTED_PROXY_HOPS` (default 1) is how many proxies in front of the app append to the
 *   header. The client IP is the entry that many places from the right. With one proxy that is
 *   the right-most entry, which is also correct when the proxy overwrites the header instead.
 * - `CLIENT_IP_HEADER` (optional, for example `x-real-ip`) names a single-value header the edge
 *   sets itself. When set, it wins over X-Forwarded-For.
 * - `TRUSTED_PROXY_HOPS=0` means no proxy is trusted: forwarding headers are ignored.
 *
 * Which header Railway's edge sets is an owner check (handbook 7.5): confirm it once by
 * comparing the `ip` of a new LOGIN audit row with your own public address.
 */

const MAX_IP_LENGTH = 64;
const IP_CHARS = /^[0-9A-Fa-f:.]+$/;

/** Accept only something shaped like an IPv4/IPv6 address, so a header can't grow limiter keys. */
function cleanIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  // "[2001:db8::1]:443" or "1.2.3.4:5678" -> bare address.
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  if (bracket) v = bracket[1]!;
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) v = v.slice(0, v.lastIndexOf(':'));
  if (!v || v.length > MAX_IP_LENGTH || !IP_CHARS.test(v)) return null;
  return v;
}

function trustedHops(env: NodeJS.ProcessEnv): number {
  const raw = env.TRUSTED_PROXY_HOPS;
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

export function clientIpFromHeaders(headers: Headers, env: NodeJS.ProcessEnv = process.env): string | null {
  const hops = trustedHops(env);
  if (hops === 0) return null;

  const named = env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (named) {
    const v = headers.get(named);
    // A single-value header; if a proxy chain turned it into a list, the last entry is the edge's.
    return cleanIp(v?.split(',').pop());
  }

  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) {
      // Fewer entries than trusted hops: every entry was written by a trusted proxy, so the
      // left-most one is the client.
      const idx = Math.max(0, parts.length - hops);
      return cleanIp(parts[idx]);
    }
  }
  return cleanIp(headers.get('x-real-ip'));
}

export function clientIp(req: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  return clientIpFromHeaders(req.headers, env);
}
