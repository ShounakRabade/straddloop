/* Test double for the Supabase calls the Lab makes, so the real-data path can be driven in a browser
 * without a network or an account. Build the site with
 *   NEXT_PUBLIC_SUPABASE_URL=https://stubproject.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_test
 * and call `mockSupabase(context, { dayDir })` before opening a page.
 *
 * `MARKET_DAYS` mirrors the metadata of the rows stored in the project's market_days table when this file was
 * written (NIFTY weekly, 6–17 Oct 2025). Day-file bodies come from `dayDir` (written by `straddloop export-days`);
 * in tests these are synthetic sessions in the real file format, never real prices. */
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');

const REF = 'stubproject';
const ASSUMED_EXPIRY = 'assumed: nearest weekly expiry weekday (Thu before 1 Sep 2025, Tue after), holidays not applied; bhavcopy not yet checked';
const day = (d, expiry, quality = 'complete') => ({
  trade_date: d, path: `NIFTY/WEEK/${d}.json.gz`, series: 42, index_bars: quality === 'complete' ? 375 : 374,
  expiry, lot_size: 75, quality, bytes: 150000, expiry_source: ASSUMED_EXPIRY,
});
const MARKET_DAYS = [
  day('2025-10-06', '2025-10-07', 'gaps:1'), day('2025-10-07', '2025-10-07'), day('2025-10-08', '2025-10-14'), day('2025-10-09', '2025-10-14'),
  day('2025-10-10', '2025-10-14'), day('2025-10-13', '2025-10-14'), day('2025-10-14', '2025-10-14'), day('2025-10-15', '2025-10-21'),
  day('2025-10-16', '2025-10-21'), day('2025-10-17', '2025-10-21'),
];

function b64url(o) { return Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }

/**
 * opts.reader: false makes the account a non-reader. opts.statuses: rows for market_day_status (default: the
 * table does not exist, as in the live project today). opts.days: override MARKET_DAYS. opts.signedIn: false
 * leaves the visitor signed out.
 * With opts.dayDir, each row's sha256 is the hash of that file's JSON (as `straddloop supabase-upload` writes it), so the
 * Lab checks every download. opts.tamper: a date (or { date }, which can be changed while the page is open) whose file
 * is served altered; its listed sha256 stays the original. opts.downloads: an object whose `count` grows with each file served.
 */
async function mockSupabase(context, opts = {}) {
  const shaOf = (d) => {
    const file = opts.dayDir && path.join(opts.dayDir, path.basename(d.path));
    return file && fs.existsSync(file) ? crypto.createHash('sha256').update(zlib.gunzipSync(fs.readFileSync(file))).digest('hex') : null;
  };
  const days = (opts.days || MARKET_DAYS).map((d) => ({ ...d, sha256: d.sha256 ?? shaOf(d) }));
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
  const user = { id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'tester@example.test', app_metadata: {}, user_metadata: {}, created_at: '2025-01-01T00:00:00Z' };
  const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, exp, role: 'authenticated', aud: 'authenticated' })}.sig`;
  const session = { access_token: token, refresh_token: 'stub-refresh', expires_in: 86400, expires_at: exp, token_type: 'bearer', user };
  if (opts.signedIn !== false) {
    await context.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } }, [`sb-${REF}-auth-token`, JSON.stringify(session)]);
  }
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  await context.route(`https://${REF}.supabase.co/**`, async (route) => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const p = url.pathname;
    if (p.startsWith('/auth/v1/user')) return json(route, user);
    if (p.startsWith('/auth/v1/')) return json(route, {});
    if (p === '/rest/v1/data_readers') return opts.reader === false ? json(route, null) : json(route, { user_id: user.id });
    if (p === '/rest/v1/market_days') {
      const flag = url.searchParams.get('expiry_flag');
      return json(route, flag === 'eq.WEEK' ? days : []);
    }
    if (p === '/rest/v1/market_day_status') {
      if (!opts.statuses) return json(route, { code: '42P01', message: 'relation "public.market_day_status" does not exist' }, 404);
      return json(route, opts.statuses);
    }
    if (p === '/rest/v1/runs' || p === '/rest/v1/profiles') return json(route, req.method() === 'GET' ? [] : {});
    const m = p.match(/\/storage\/v1\/object\/(?:authenticated\/)?market-data\/(.+)$/);
    if (m && opts.dayDir) {
      const file = path.join(opts.dayDir, path.basename(decodeURIComponent(m[1])));
      if (fs.existsSync(file)) {
        if (opts.downloads) opts.downloads.count = (opts.downloads.count || 0) + 1;
        let body = fs.readFileSync(file);
        const tamper = opts.tamper && (typeof opts.tamper === 'string' ? opts.tamper : opts.tamper.date);
        if (tamper && path.basename(file).startsWith(tamper)) {
          // one price changed by a paisa: still a valid day file, but not the one the inventory lists
          const doc = JSON.parse(zlib.gunzipSync(body).toString('utf8'));
          doc.series[0].c[5] = (doc.series[0].c[5] || 0) + 1;
          body = zlib.gzipSync(Buffer.from(JSON.stringify(doc)));
        }
        return route.fulfill({ status: 200, contentType: 'application/gzip', headers: { 'access-control-allow-origin': '*' }, body });
      }
      return json(route, { statusCode: '404', error: 'not_found', message: 'Object not found' }, 400);
    }
    return json(route, { message: `unmocked ${req.method()} ${p}` }, 404);
  });
}

module.exports = { mockSupabase, MARKET_DAYS, REF };
