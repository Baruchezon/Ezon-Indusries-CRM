const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_TOKEN = process.env.SESSION_TOKEN;

if (!SUPABASE_URL || !SUPABASE_KEY || !APP_PASSWORD || !SESSION_TOKEN) {
  console.error('Missing required environment variables');
  process.exit(1);
}

function send(res, status, body, type='application/json; charset=utf-8', headers={}) {
  res.writeHead(status, {'Content-Type': type, ...headers});
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function cookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim());
  });
  return out;
}

function authed(req) {
  return cookies(req).ezon_session === SESSION_TOKEN;
}

function safeEqual(a,b){
  const ha=crypto.createHash('sha256').update(String(a)).digest();
  const hb=crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha,hb);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data='';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function sb(table, query='select=*', opts={}) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? `?${query}` : ''}`;
  const r = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {})
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(`${r.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (u.pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!safeEqual(body.password || '', APP_PASSWORD)) return send(res, 401, {ok:false, error:'סיסמה שגויה'});
      return send(res, 200, {ok:true}, 'application/json; charset=utf-8', {
        'Set-Cookie': `ezon_session=${encodeURIComponent(SESSION_TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`
      });
    }

    if (u.pathname === '/api/logout' && req.method === 'POST') {
      return send(res, 200, {ok:true}, 'application/json; charset=utf-8', {
        'Set-Cookie': 'ezon_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
      });
    }

    if (u.pathname === '/api/session' && req.method === 'GET') return send(res, 200, {authenticated: authed(req)});

    if (u.pathname.startsWith('/api/') && !authed(req)) return send(res, 401, {error:'unauthorized'});

    if (u.pathname === '/api/dashboard' && req.method === 'GET') {
      const [orders, invoices, receipts, jobs, items, logs] = await Promise.all([
        sb('rivhit_orders','select=order_number,customer_name,order_date,amount,is_closed&order=order_date.desc&limit=50'),
        sb('rivhit_invoices','select=document_number,customer_name,document_date,amount,is_closed&order=document_date.desc&limit=50'),
        sb('rivhit_receipts','select=receipt_number,customer_name,receipt_date,amount&order=receipt_date.desc&limit=50'),
        sb('production_jobs','select=*&order=created_at.desc&limit=100'),
        sb('production_job_items','select=*&order=created_at.desc&limit=500'),
        sb('production_daily_log','select=*&order=log_date.desc,created_at.desc&limit=200')
      ]);
      return send(res, 200, {orders,invoices,receipts,jobs,items,logs});
    }

    if (u.pathname === '/api/orders' && req.method === 'GET') {
      const data = await sb('rivhit_orders','select=*&order=order_date.desc&limit=300');
      return send(res, 200, data);
    }

    if (u.pathname === '/api/customers' && req.method === 'GET') {
      const data = await sb('rivhit_customers','select=customer_id,customer_name,updated_at&order=customer_name.asc&limit=500');
      return send(res, 200, data);
    }

    if (u.pathname === '/api/jobs' && req.method === 'GET') {
      const data = await sb('production_jobs','select=*&order=created_at.desc&limit=300');
      return send(res, 200, data);
    }

    if (u.pathname === '/api/items' && req.method === 'GET') {
      const data = await sb('production_job_items','select=*&order=created_at.desc&limit=1000');
      return send(res, 200, data);
    }

    if (u.pathname === '/api/stages' && req.method === 'GET') {
      const data = await sb('production_item_stages','select=*&order=sort_order.asc&limit=2000');
      return send(res, 200, data);
    }

    if (u.pathname === '/api/logs' && req.method === 'GET') {
      const data = await sb('production_daily_log','select=*&order=log_date.desc,created_at.desc&limit=500');
      return send(res, 200, data);
    }

    if (u.pathname === '/api/logs' && req.method === 'POST') {
      const body = await readBody(req);
      const payload = {
        job_item_id: body.job_item_id,
        item_stage_id: body.item_stage_id || null,
        stage_id: body.stage_id || null,
        log_date: body.log_date,
        quantity: Number(body.quantity || 0),
        machine_type: body.machine_type || null,
        notes: body.notes || null
      };
      const data = await sb('production_daily_log','', {method:'POST', body:payload});
      return send(res, 201, data);
    }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      return send(res, 200, indexHtml, 'text/html; charset=utf-8');
    }

    return send(res, 404, {error:'not found'});
  } catch (e) {
    console.error(e);
    return send(res, 500, {error:'server error', detail:String(e.message || e)});
  }
});

server.listen(PORT, () => console.log(`Ezon Industries CRM listening on ${PORT}`));
