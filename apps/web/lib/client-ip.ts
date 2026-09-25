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

// Private, loopback, link-local and carrier-grade NAT ranges: a "client" IP in these is almost
// always a proxy, which would make every user share one rate-limit bucket.
const INTERNAL_IP =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;
let warnedInternal = false;

function checked(ip: string | null, env: NodeJS.ProcessEnv): string | null {
  if (ip && !warnedInternal && env.NODE_ENV === 'production' && INTERNAL_IP.test(ip)) {
    warnedInternal = true;
    console.warn(
      `[client-ip] the client IP resolved to an internal address (${ip}). Check TRUSTED_PROXY_HOPS / CLIENT_IP_HEADER: otherwise all users share one rate-limit bucket and audit rows show the proxy.`,
    );
  }
  return ip;
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
    return checked(cleanIp(v?.split(',').pop()), env);
  }

  const xff = headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) {
      // Fewer entries than trusted hops: every entry was written by a trusted proxy, so the
      // left-most one is the client.
      const idx = Math.max(0, parts.length - hops);
      return checked(cleanIp(parts[idx]), env);
    }
  }
  return checked(cleanIp(headers.get('x-real-ip')), env);
}

export function clientIp(req: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  return clientIpFromHeaders(req.headers, env);
}
