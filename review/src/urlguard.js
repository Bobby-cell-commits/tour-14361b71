// Origin allowlist for every operator-supplied URL (F-29).
//
// The share link carries its asset base in the `#b=` fragment and the page repo is public,
// so ANY reader can hand the viewer a base/scene/asset URL. Without a check that renders
// attacker-controlled SOG/GLB/JSON under the operator's own origin and chrome — and it is the
// delivery vehicle for the staging.json → editor XSS chain (F-30).
//
// Policy: relative paths (same-origin by construction), the page's own origin, the Supabase
// shares origin, and localhost/127.0.0.1 while developing on localhost. Everything else is
// refused — the caller shows a visible warning and falls back to the packaged assets.
//
// Dependency-free on purpose (node-testable, same as collision.js).

const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const isDevHost = host => DEV_HOSTS.has(host);

/**
 * @param {object} o
 * @param {string} o.sharesBase - the SHARES_BASE constant (main.js owns the literal)
 * @param {Location|{origin:string,hostname:string,href:string}} [o.loc] - injectable for tests
 */
export function createUrlGuard({ sharesBase, loc = location }) {
  let sharesOrigin = null;
  try { sharesOrigin = new URL(sharesBase).origin; } catch { sharesOrigin = null; }
  const devMode = isDevHost(loc.hostname);

  /**
   * true when `url` is safe to load. Relative values are always fine — they resolve against
   * the page. Absolute values must match the page origin, the shares origin, or (dev only)
   * a localhost origin.
   */
  function isAllowed(url) {
    if (url == null || url === '') return true;
    let u;
    try { u = new URL(url, loc.href); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;   // no data:/blob:/javascript:
    if (u.origin === loc.origin) return true;
    if (sharesOrigin && u.origin === sharesOrigin) return true;
    if (devMode && isDevHost(u.hostname)) return true;
    return false;
  }

  return {
    isAllowed,
    sharesOrigin,
    /** isAllowed(url) ? url : null — the caller decides what to say about the refusal. */
    filter: url => (isAllowed(url) ? url : null),
  };
}
