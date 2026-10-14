// Paygate operator console. Talks to /admin/* with the operator key, which lives in sessionStorage only (gone when the tab closes).
// Everything from the API is rendered with textContent, never as HTML: provider callback bodies are untrusted.

const store = { get: () => { try { return sessionStorage.getItem('pg_admin') } catch { return null } }, set: (v) => { try { v ? sessionStorage.setItem('pg_admin', v) : sessionStorage.removeItem('pg_admin') } catch {} } };
let key = store.get();
const app = document.getElementById('app');

function h(tag, attrs, ...kids) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v == null || v === false) continue;
		if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'class') el.className = v;
		else if (v === true) el.setAttribute(k, '');
		else el.setAttribute(k, v);
	}
	for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
	return el;
}

const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false));

class AuthError extends Error {}
async function api(method, path, body) {
	const res = await fetch(path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (res.status === 401) throw new AuthError(data?.error?.message || 'Unauthorized');
	if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
	return data;
}

const fmtAmount = (n) => n == null ? '–' : `${new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ')} FCFA`;
const fmtTime = (ms) => ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
const ago = (ms) => { if (!ms) return '–'; const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };
const PSP = { pawapay: 'pawaPay', pispi: 'PI-SPI', sandbox: 'Sandbox' };
const OPERATOR = { orange: 'Orange Money', wave: 'Wave', moov: 'Moov Money' };
const RAIL = { mobile_money: 'Mobile money', pispi_qr: 'Bank · QR code', pispi_rtp: 'Bank · payment request' };
const ICON = { orange: 'orange', wave: 'wave', moov: 'moov' };
const icon = (p) => { const f = p.rail === 'mobile_money' ? ICON[p.operator] : p.rail.startsWith('pispi') ? 'pispi' : null; return f ? h('img', { class: 'logo', src: `/providers/${f}.png`, alt: '', width: 20, height: 20 }) : null; };
const COUNTRY = { CIV: ['ci', "Côte d'Ivoire"], SEN: ['sn', 'Senegal'], BFA: ['bf', 'Burkina Faso'] };
const origin = (p) => { const c = COUNTRY[p.country]; return c ? h('span', { class: 'chan' }, h('img', { class: 'flag', src: `/country/${c[0]}.png`, alt: '', width: 20, height: 20 }), h('span', { title: c[1] }, p.country)) : h('span', { class: 'muted' }, '–'); };
const pspBadge = (p) => h('span', { class: `badge psp psp-${p.provider}` }, PSP[p.provider] || p.provider);
const channel = (p) => p.rail === 'mobile_money' ? (OPERATOR[p.operator] || p.operator || 'Mobile money') : (RAIL[p.rail] || p.rail);
const badge = (s) => h('span', { class: `badge s-${s}` }, s);
const pretty = (t) => { if (!t) return null; try { return JSON.stringify(JSON.parse(t), null, 2) } catch { return t } };
const toast = (m) => { const t = h('div', { class: 'toast', role: 'status' }, m); document.body.append(t); setTimeout(() => t.remove(), 2600); };
const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast('Copied') } catch { toast('Copy failed: select the text instead') } };

// ---- overlays -------------------------------------------------------------------------------------------------------------------
function overlay(content, { center = false } = {}) {
	const box = h('div', { class: center ? 'modal' : 'drawer', role: 'dialog', 'aria-modal': 'true' }, content);
	const ov = h('div', { class: `overlay${center ? ' center' : ''}`, onclick: (e) => { if (e.target === ov) close() } }, box);
	const onKey = (e) => { if (e.key === 'Escape') close() };
	const close = () => { ov.remove(); document.removeEventListener('keydown', onKey) };
	document.addEventListener('keydown', onKey);
	document.body.append(ov);
	box.querySelector('input, textarea, select, button')?.focus();
	return { close, box };
}
function secretModal(title, note, value) {
	const m = overlay([h('h2', {}, title), h('p', { class: 'muted' }, note), h('code', { class: 'secret' }, value),
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => copy(value) }, 'Copy'), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done'))], { center: true });
}
function confirmModal(title, text, label, onYes) {
	const m = overlay([h('h2', {}, title), h('p', {}, text), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
		h('button', { class: 'btn danger solid', onclick: async (e) => { e.target.disabled = true; try { await onYes(); m.close() } catch (err) { e.target.disabled = false; toast(err.message) } } }, label))], { center: true });
}
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label, hint ? h('small', {}, ` ${hint}`) : null), input);

// ---- login ----------------------------------------------------------------------------------------------------------------------
function login(msg) {
	const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'ADMIN_API_KEY', 'aria-label': 'Operator key' });
	const form = h('form', { class: 'login', onsubmit: async (e) => {
		e.preventDefault(); key = input.value.trim();
		try { await api('GET', '/admin/float'); store.set(key); start() } catch (err) { key = null; login(err instanceof AuthError ? 'That key was not accepted.' : err.message) }
	} }, h('h1', {}, 'Paygate'), h('p', { class: 'sub' }, 'Operator console. The key stays in this tab only.'), msg ? h('div', { class: 'alert bad' }, msg) : null,
		field('Operator key', input), h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')));
	put(app, form); input.focus();
}

// ---- shell + router -------------------------------------------------------------------------------------------------------------
const PAGES = { overview: ['Overview', overview], payments: ['Payments', payments], tenants: ['Tenants', tenants], webhooks: ['Failed webhooks', webhooks], callbacks: ['Provider callbacks', callbacks] };
let attention = { unknown: 0, dead: 0 };

async function start() {
	if (!key) return login();
	window.addEventListener('hashchange', route);
	route();
}
async function route() {
	document.querySelectorAll('.overlay').forEach((o) => o.remove());
	const name = (location.hash.slice(2) || 'overview').split('?')[0];
	const page = PAGES[name] ? name : 'overview';
	const main = h('main', { class: 'main' }, h('p', { class: 'muted' }, 'Loading…'));
	const nav = h('nav', { class: 'nav' }, Object.entries(PAGES).map(([id, [label]]) => {
		const n = id === 'payments' ? attention.unknown : id === 'webhooks' ? attention.dead : 0;
		return h('a', { href: `#/${id}`, 'aria-current': id === page ? 'page' : null }, label, n ? h('span', { class: 'count' }, n) : null);
	}));
	put(app, h('div', { class: 'shell' }, h('aside', { class: 'side' }, h('div', { class: 'brand' }, 'Paygate', h('small', {}, 'Operator console')), nav, h('div', { class: 'spacer' }),
		h('button', { class: 'btn sm', onclick: () => { store.set(null); key = null; location.hash = ''; login() } }, 'Sign out')), main));
	try {
		await PAGES[page][1](main);
		refreshAttention(nav);
	} catch (e) {
		if (e instanceof AuthError) { store.set(null); key = null; return login('Session ended. Sign in again.') }
		put(main, h('div', { class: 'alert bad' }, e.message), h('button', { class: 'btn', onclick: route }, 'Retry'));
	}
}
async function refreshAttention(nav) {
	try {
		const [u, d] = await Promise.all([api('GET', '/admin/payments?status=unknown'), api('GET', '/admin/webhooks/dead')]);
		attention = { unknown: u.data.length, dead: d.data.length };
		const set = (id, n) => { const a = [...nav.children].find((x) => x.getAttribute('href') === `#/${id}`); if (!a) return; a.querySelector('.count')?.remove(); if (n) a.append(h('span', { class: 'count' }, n)); };
		set('payments', attention.unknown); set('webhooks', attention.dead);
	} catch { /* the badge is a convenience */ }
}
const head = (title, sub, ...actions) => h('div', { class: 'bar' }, h('div', { class: 'grow' }, h('h1', {}, title), sub ? h('p', { class: 'sub m0' }, sub) : null), actions);
const table = (cols, rows, empty) => rows.length
	? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : null }, c.label)))), h('tbody', {}, rows)))
	: h('div', { class: 'card empty' }, empty);

// ---- overview -------------------------------------------------------------------------------------------------------------------
async function overview(main) {
	const [flt, prov, unknown, dead, recent] = await Promise.all([api('GET', '/admin/float'), api('GET', '/admin/providers'), api('GET', '/admin/payments?status=unknown'), api('GET', '/admin/webhooks/dead'), api('GET', '/admin/payments')]);
	const todo = [];
	if (unknown.data.length) todo.push(h('div', { class: 'alert bad' }, h('strong', {}, `${unknown.data.length} payout(s) with an unknown outcome. `), 'Money may have been sent: a person must decide. ', h('a', { href: '#/payments?status=unknown' }, 'Review')));
	if (dead.data.length) todo.push(h('div', { class: 'alert warn' }, h('strong', {}, `${dead.data.length} webhook(s) could not be delivered. `), h('a', { href: '#/webhooks' }, 'Review')));
	if (!todo.length) todo.push(h('div', { class: 'alert ok' }, 'Nothing needs a person right now.'));

	put(main, head('Overview', `Payout float floor ${fmtAmount(flt.floor)}`, h('button', { class: 'btn', onclick: route }, 'Refresh')), ...todo, h('h2', {}, 'Payment providers (last 24 h)'), providerCards(prov, flt),
		h('h2', {}, 'Latest payments'), paymentsTable(recent.data.slice(0, 10)));
}

function floatBlock(flt) {
	if (!flt.rows) return null;
	return h('div', { class: 'wallets' }, h('div', { class: 'wl' }, h('span', { class: 'pl' }, 'Payout float'), h('span', { class: 'pl' }, `floor ${fmtAmount(flt.floor)}`)),
		flt.rows.map((r) => h('div', { class: 'wallet' },
			h('span', { class: 'chan' }, COUNTRY[r.country] ? h('img', { class: 'flag', src: `/country/${COUNTRY[r.country][0]}.png`, alt: '', width: 20, height: 20 }) : null, r.country),
			h('span', { class: 'wbal' }, r.balance === null ? 'No wallet' : fmtAmount(r.balance)),
			h('span', { class: 'muted wsub' }, r.coverDays === null ? 'no recent payouts' : `${r.coverDays} days cover`), badge(r.status),
			r.committed ? h('span', { class: 'muted wnote' }, `${fmtAmount(r.committed)} committed (${r.committedCount})`) : null,
			...r.reasons.map((x) => h('span', { class: 'bad-text wnote' }, x)))));
}
function providerCards(prov, flt) {
	return h('div', { class: 'pgrid' }, prov.data.map((p) => {
		const mine = prov.last24h.filter((r) => r.provider === p.id);
		const sum = (f) => mine.filter(f).reduce((n, r) => ({ n: n.n + r.n, amount: n.amount + (r.amount || 0) }), { n: 0, amount: 0 });
		const inn = sum((r) => r.kind === 'collection' && r.status === 'completed'), out = sum((r) => r.kind === 'disbursement' && r.status === 'completed');
		const bad = sum((r) => r.status === 'failed' || r.status === 'unknown'), open = sum((r) => r.status === 'processing');
		const mark = p.id === 'pispi' ? h('img', { class: 'pmark', src: '/providers/pispi.png', alt: '', width: 40, height: 40 }) : h('span', { class: 'pmark mono-mark' }, p.id === 'sandbox' ? 'SB' : 'pP');
		const stat = (label, big, small, bad) => h('div', { class: 'pstat' }, h('div', { class: 'pl' }, label), h('div', { class: `pv${bad ? ' bad-text' : ''}` }, big), h('div', { class: 'ps' }, small));
		return h('section', { class: `card pcard${p.active ? '' : ' off'}` },
			h('header', { class: 'phead' }, mark, h('div', { class: 'grow' }, h('h3', {}, p.name), h('p', { class: 'muted m0' }, p.role)), badge(p.active ? 'active' : 'idle')),
			h('div', { class: 'prow' }, h('span', { class: 'pl' }, 'Channels'), h('span', { class: 'chans' }, p.channels.map((c) => h('span', { class: 'chip' }, h('img', { class: 'logo', src: `/providers/${c === 'bank' ? 'pispi' : c}.png`, alt: '', width: 20, height: 20 }), OPERATOR[c] || 'Bank accounts')))),
			h('div', { class: 'prow' }, h('span', { class: 'pl' }, 'Countries'), h('span', { class: 'chans' }, p.countries.map((c) => h('span', { class: 'chip' }, COUNTRY[c] ? h('img', { class: 'flag', src: `/country/${COUNTRY[c][0]}.png`, alt: '', width: 20, height: 20 }) : null, COUNTRY[c]?.[1] || c)))),
			p.notes.length ? h('div', { class: 'prow' }, h('span', { class: 'pl' }, 'Setup'), h('span', { class: 'chans' }, p.notes.map((n) => h('span', { class: 'tag' }, n)))) : null,
			p.id === flt.provider ? floatBlock(flt) : null,
			p.active || mine.length ? h('div', { class: 'pstats' },
				stat('Collected', fmtAmount(inn.amount), `${inn.n} payment${inn.n === 1 ? '' : 's'}`), stat('Paid out', fmtAmount(out.amount), `${out.n} payment${out.n === 1 ? '' : 's'}`),
				stat('In progress', String(open.n), 'waiting'), stat('Failed / unknown', String(bad.n), 'last 24 h', bad.n > 0)) : h('p', { class: 'muted m0' }, 'No activity in the last 24 hours.'));
	}));
}

// ---- payments -------------------------------------------------------------------------------------------------------------------
function paymentsTable(rows) {
	return table([{ label: 'When' }, { label: 'Tenant' }, { label: 'Type' }, { label: 'PSP' }, { label: 'Channel' }, { label: 'Origin' }, { label: 'Reference' }, { label: 'Counterparty' }, { label: 'Amount', num: true }, { label: 'Status' }],
		rows.map((p) => h('tr', { class: 'click', tabindex: 0, onclick: () => paymentDrawer(p.id), onkeydown: (e) => { if (e.key === 'Enter') paymentDrawer(p.id) } },
			h('td', { title: fmtTime(p.createdAt) }, ago(p.createdAt)), h('td', {}, p.tenant), h('td', {}, p.object === 'collection' ? '↓ in' : '↑ out'), h('td', {}, pspBadge(p)), h('td', {}, h('span', { class: 'chan' }, icon(p), channel(p))), h('td', {}, origin(p)),
			h('td', { class: 'mono' }, p.reference), h('td', { class: 'mono' }, p.counterparty || '–'), h('td', { class: 'num' }, fmtAmount(p.amount)), h('td', {}, badge(p.status)))),
		'No payments match.');
}
async function payments(main) {
	const q = new URLSearchParams(location.hash.split('?')[1] || '');
	const sel = (name, opts) => { const s = h('select', { 'aria-label': name }, opts.map(([v, l]) => h('option', { value: v, selected: q.get(name) === v ? true : null }, l))); return s; };
	const status = sel('status', [['', 'Any status'], ['processing', 'Processing'], ['unknown', 'Unknown'], ['completed', 'Completed'], ['failed', 'Failed'], ['expired', 'Expired']]);
	const kind = sel('kind', [['', 'In and out'], ['collection', 'Collections (in)'], ['disbursement', 'Disbursements (out)']]);
	const tenant = h('input', { placeholder: 'Tenant id', value: q.get('tenant') || '', 'aria-label': 'tenant', size: 14 });
	const find = h('input', { placeholder: 'Find a payment id…', 'aria-label': 'Open payment by id', size: 24 });
	const apply = () => { const p = new URLSearchParams(); if (status.value) p.set('status', status.value); if (kind.value) p.set('kind', kind.value); if (tenant.value.trim()) p.set('tenant', tenant.value.trim()); history.replaceState(null, '', `#/payments${p.size ? '?' + p : ''}`); load(); };
	for (const el of [status, kind]) el.addEventListener('change', apply);
	tenant.addEventListener('change', apply);
	find.addEventListener('keydown', (e) => { if (e.key === 'Enter' && find.value.trim()) paymentDrawer(find.value.trim()) });
	const out = h('div');
	const load = async () => {
		const p = new URLSearchParams(); if (status.value) p.set('status', status.value); if (kind.value) p.set('kind', kind.value); if (tenant.value.trim()) p.set('tenant', tenant.value.trim());
		put(out, h('p', { class: 'muted' }, 'Loading…'));
		try { const r = await api('GET', `/admin/payments${p.size ? '?' + p : ''}`); put(out, paymentsTable(r.data), r.data.length === 100 ? h('p', { class: 'muted' }, 'Showing the latest 100.') : null) } catch (e) { put(out, h('div', { class: 'alert bad' }, e.message)) }
	};
	put(main, head('Payments', null, h('button', { class: 'btn', onclick: load }, 'Refresh')), h('div', { class: 'bar' }, status, kind, tenant, h('span', { class: 'grow' }), find), out);
	load();
}
async function paymentDrawer(id) {
	const d = overlay(h('p', { class: 'muted' }, 'Loading…'));
	const render = (p) => {
		const resolvable = p.status === 'processing' || p.status === 'unknown' ? ['completed', 'failed'] : p.status === 'failed' || p.status === 'expired' ? ['completed'] : [];
		const row = (k, v) => v == null || v === '' ? null : [h('dt', {}, k), h('dd', {}, v)];
		put(d.box, 
			h('div', { class: 'bar' }, h('h1', { class: 'grow mono t16' }, p.id), badge(p.status), h('button', { class: 'btn sm', onclick: d.close }, 'Close')),
			p.status === 'unknown' ? h('div', { class: 'alert bad' }, 'The outcome of this payout is unknown. Check the provider dashboard for the money before deciding.') : null,
			h('div', { class: 'card' }, h('dl', { class: 'kv' },
				row('Tenant', p.tenant), row('Type', p.object), row('Reference', h('span', { class: 'mono' }, p.reference)), row('PSP partner', pspBadge(p)), row(p.rail === 'mobile_money' ? 'Channel (MNO)' : 'Channel', h('span', { class: 'chan' }, icon(p), channel(p))), row('Rail', p.rail), row('Origin', COUNTRY[p.country] ? h('span', { class: 'chan' }, origin(p), COUNTRY[p.country][1]) : null), row('Amount', fmtAmount(p.amount)), row('Counterparty', h('span', { class: 'mono' }, p.counterparty || '')),
				row('PSP payment id', h('span', { class: 'mono' }, p.providerId || '')), row('PSP settlement ref', h('span', { class: 'mono' }, p.providerRef || '')),
				row('Created', fmtTime(p.createdAt)), row('Expires', p.expiresAt ? fmtTime(p.expiresAt) : null), row('Settled', p.settledAt ? fmtTime(p.settledAt) : null), row('Attempts', String(p.attempts)),
				row('Failure shown', p.failure), row('Failure detail', p.failureDetail), row('Metadata', p.metadata ? h('pre', {}, JSON.stringify(p.metadata, null, 2)) : null))),
			resolvable.length ? h('div', { class: 'actions mb16' }, h('button', { class: 'btn primary', onclick: () => resolveModal(p, resolvable, async (np) => { render({ ...np, events: (await api('GET', `/admin/payments/${p.id}`)).events }); }) }, 'Resolve manually…')) : null,
			h('h2', {}, 'History'),
			h('ul', { class: 'timeline' }, p.events.map((e) => h('li', {}, h('strong', {}, e.type), e.type === 'late_completion' ? h('span', { class: 'badge late ml8' }, 'late') : null, ' ', h('span', { class: 'muted' }, `by ${e.actor}`), e.detail ? h('div', {}, e.detail) : null, h('div', { class: 't' }, fmtTime(e.created_at))))));
	};
	try { render(await api('GET', `/admin/payments/${encodeURIComponent(id)}`)) } catch (e) { put(d.box, h('div', { class: 'alert bad' }, e.message), h('button', { class: 'btn', onclick: d.close }, 'Close')) }
}
function resolveModal(p, outcomes, done) {
	const outcome = h('select', { 'aria-label': 'Outcome' }, outcomes.map((o) => h('option', { value: o }, o === 'completed' ? 'Completed: the money moved' : 'Failed: the money did not move')));
	const note = h('textarea', { rows: 3, maxlength: 300, placeholder: 'What you checked, e.g. "Confirmed in the pawaPay dashboard, payout PAID"' });
	const err = h('div');
	const m = overlay([h('h2', {}, 'Resolve payment'), h('p', { class: 'muted' }, 'This overrides the gateway and notifies the tenant by webhook. It cannot be undone.'),
		field('Outcome', outcome), field('Note', note, '(required, kept in the history)'), err,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
			h('button', { class: 'btn primary', onclick: async (e) => {
				if (!note.value.trim()) { put(err, h('div', { class: 'alert bad' }, 'A note is required.')); return; }
				e.target.disabled = true;
				try { const np = await api('POST', `/admin/payments/${p.id}/resolve`, { outcome: outcome.value, note: note.value }); m.close(); toast('Resolved'); await done(np); } catch (x) { e.target.disabled = false; put(err, h('div', { class: 'alert bad' }, x.message)); }
			} }, 'Resolve'))], { center: true });
}

// ---- tenants --------------------------------------------------------------------------------------------------------------------
async function tenants(main) {
	const { data } = await api('GET', '/admin/tenants');
	put(main, head('Tenants', 'The products that use this gateway.', h('button', { class: 'btn primary', onclick: () => tenantForm(null) }, 'New tenant')),
		table([{ label: 'Id' }, { label: 'Name' }, { label: 'Status' }, { label: 'Webhook' }, { label: 'Max payment', num: true }, { label: 'Created' }],
			data.map((t) => h('tr', { class: 'click', tabindex: 0, onclick: () => tenantDrawer(t.id), onkeydown: (e) => { if (e.key === 'Enter') tenantDrawer(t.id) } },
				h('td', { class: 'mono' }, t.id), h('td', {}, t.name), h('td', {}, badge(t.status)), h('td', { class: 'mono' }, t.webhook_url || '–'), h('td', { class: 'num' }, t.max_amount ? fmtAmount(t.max_amount) : 'default'), h('td', {}, fmtTime(t.created_at)))),
			'No tenants yet. Create one for each product that will use Paygate.'));
}
function tenantForm(t) {
	const f = { id: h('input', { value: t?.id || '', disabled: t ? true : null, placeholder: 'relay', pattern: '[a-z][a-z0-9-]{1,31}' }), name: h('input', { value: t?.name || '', maxlength: 80 }),
		webhook: h('input', { type: 'url', value: t?.webhook_url || '', placeholder: 'https://example.com/paygate/webhook' }), max: h('input', { type: 'number', min: 100, step: 1, value: t?.max_amount || '', placeholder: 'gateway default' }),
		ns: h('input', { value: '', placeholder: 'leave empty for new products' }) };
	const err = h('div');
	const m = overlay([h('h2', {}, t ? `Edit ${t.id}` : 'New tenant'), t ? null : field('Id', f.id, '(permanent, lowercase)'), field('Name', f.name), field('Webhook URL', f.webhook, '(https)'), field('Max single payment', f.max, '(FCFA)'),
		t ? null : field('ID namespace', f.ns, '(only for products migrated from another gateway)'), err,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: async (e) => {
			e.target.disabled = true;
			try {
				const max = f.max.value.trim() ? Number(f.max.value) : null, wh = f.webhook.value.trim() || null;
				if (t) await api('PATCH', `/admin/tenants/${t.id}`, { name: f.name.value, webhookUrl: wh, maxAmount: max });
				else await api('POST', '/admin/tenants', { id: f.id.value.trim(), name: f.name.value, webhookUrl: wh, maxAmount: max, idNamespace: f.ns.value.trim() || null });
				m.close(); toast('Saved'); route();
				if (!t) tenantDrawer(f.id.value.trim());
			} catch (x) { e.target.disabled = false; put(err, h('div', { class: 'alert bad' }, x.message)); }
		} }, 'Save'))], { center: true });
}
async function tenantDrawer(id) {
	const d = overlay(h('p', { class: 'muted' }, 'Loading…'));
	const render = async () => {
		const [t, keys] = await Promise.all([api('GET', `/admin/tenants/${id}`), api('GET', `/admin/tenants/${id}/keys`)]);
		put(d.box, 
			h('div', { class: 'bar' }, h('h1', { class: 'grow' }, t.name), badge(t.status), h('button', { class: 'btn sm', onclick: d.close }, 'Close')),
			h('div', { class: 'card' }, h('dl', { class: 'kv' }, h('dt', {}, 'Id'), h('dd', { class: 'mono' }, t.id), h('dt', {}, 'Webhook'), h('dd', { class: 'mono' }, t.webhook_url || '–'), h('dt', {}, 'Max payment'), h('dd', {}, t.max_amount ? fmtAmount(t.max_amount) : 'gateway default'),
				h('dt', {}, 'Secret version'), h('dd', {}, String(t.webhook_version)), h('dt', {}, 'Created'), h('dd', {}, fmtTime(t.created_at)))),
			h('div', { class: 'actions left mb20' },
				h('button', { class: 'btn', onclick: () => tenantForm(t) }, 'Edit'),
				h('button', { class: `btn${t.status === 'active' ? ' danger' : ''}`, onclick: () => {
					const go = async () => { await api('PATCH', `/admin/tenants/${id}`, { status: t.status === 'active' ? 'suspended' : 'active' }); await render(); route(); };
					t.status === 'active' ? confirmModal('Suspend tenant?', `${t.name} will be refused on every API call until you reactivate it. Payments already in flight still settle.`, 'Suspend', go) : go();
				} }, t.status === 'active' ? 'Suspend' : 'Reactivate')),
			h('div', { class: 'bar' }, h('h2', { class: 'grow m0' }, 'API keys'), h('button', { class: 'btn sm primary', onclick: () => newKey(id, render) }, 'New key')),
			table([{ label: 'Key' }, { label: 'Label' }, { label: 'Last used' }, { label: '' }],
				keys.data.map((k) => h('tr', {}, h('td', { class: 'mono' }, `pgk_${k.id}_…`), h('td', {}, k.label || '–'), h('td', {}, k.revoked_at ? badge('dead') : ago(k.last_used_at)),
					h('td', {}, k.revoked_at ? h('span', { class: 'muted' }, 'revoked') : h('button', { class: 'btn sm danger', onclick: () => confirmModal('Revoke key?', `pgk_${k.id}_… stops working immediately. Anything still using it will get 401.`, 'Revoke', async () => { await api('DELETE', `/admin/tenants/${id}/keys/${k.id}`); await render(); }) }, 'Revoke')))),
				'No keys yet.'),
			h('h2', { class: 'mt22' }, 'Webhook signing secret'),
			h('div', { class: 'actions left mt0' },
				h('button', { class: 'btn', onclick: async () => { const s = await api('GET', `/admin/tenants/${id}/webhook-secret`); secretModal(`Webhook secret (v${s.version})`, 'Give this to the product so it can verify webhooks. Treat it like a password.', s.secret); } }, 'Reveal'),
				h('button', { class: 'btn danger', onclick: () => confirmModal('Rotate signing secret?', 'Webhooks are signed with the new secret immediately. The product must update its secret first, or it will reject events.', 'Rotate', async () => { const s = await api('POST', `/admin/tenants/${id}/webhook-secret`); secretModal(`New webhook secret (v${s.version})`, 'Give this to the product now.', s.secret); await render(); }) }, 'Rotate…')));
	};
	try { await render() } catch (e) { put(d.box, h('div', { class: 'alert bad' }, e.message), h('button', { class: 'btn', onclick: d.close }, 'Close')) }
}
function newKey(tenantId, after) {
	const label = h('input', { maxlength: 80, placeholder: 'e.g. production backend' });
	const m = overlay([h('h2', {}, 'New API key'), field('Label', label, '(optional)'), h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
		h('button', { class: 'btn primary', onclick: async (e) => {
			e.target.disabled = true;
			try { const k = await api('POST', `/admin/tenants/${tenantId}/keys`, { label: label.value.trim() || undefined }); m.close(); secretModal('API key created', 'Copy it now. Only its hash is stored, so it cannot be shown again.', k.key); await after(); } catch (x) { e.target.disabled = false; toast(x.message); }
		} }, 'Create'))], { center: true });
}

// ---- failed webhooks ------------------------------------------------------------------------------------------------------------
async function webhooks(main) {
	const { data } = await api('GET', '/admin/webhooks/dead');
	put(main, head('Failed webhooks', 'Events that were not delivered after every retry. Retrying sends them again from the start with the same event id.', h('button', { class: 'btn', onclick: route }, 'Refresh')),
		table([{ label: 'Created' }, { label: 'Tenant' }, { label: 'Event' }, { label: 'Payment' }, { label: 'Attempts', num: true }, { label: 'Last error' }, { label: '' }],
			data.map((w) => h('tr', {}, h('td', {}, ago(w.created_at)), h('td', {}, w.tenant_id), h('td', {}, w.type), h('td', { class: 'mono' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); paymentDrawer(w.payment_id) } }, w.payment_id)),
				h('td', { class: 'num' }, String(w.attempts)), h('td', {}, w.last_error || (w.last_status ? `HTTP ${w.last_status}` : '–')),
				h('td', {}, h('button', { class: 'btn sm', onclick: async (e) => { e.target.disabled = true; try { await api('POST', `/admin/webhooks/${w.id}/retry`); toast('Queued'); route(); } catch (x) { e.target.disabled = false; toast(x.message) } } }, 'Retry')))),
			'No failed webhooks.'));
}

// ---- provider callbacks ---------------------------------------------------------------------------------------------------------
async function callbacks(main) {
	const { data } = await api('GET', '/admin/provider-events');
	put(main, head('Provider callbacks', 'The last 100 callbacks exactly as they arrived. Rejected ones failed the signature or shape check.', h('button', { class: 'btn', onclick: route }, 'Refresh')),
		table([{ label: 'Received' }, { label: 'Provider' }, { label: 'Path' }, { label: 'Result' }, { label: 'Body' }],
			data.map((e) => { const body = pretty(e.body); return h('tr', {}, h('td', { title: fmtTime(e.received_at) }, ago(e.received_at)), h('td', {}, e.provider), h('td', { class: 'mono' }, e.path), h('td', {}, badge(e.accepted ? 'ok' : 'failed'), ' ', e.accepted ? 'accepted' : 'rejected'),
				h('td', {}, h('details', {}, h('summary', {}, 'view'), h('pre', {}, body)))); }),
			'No callbacks received yet.'));
}

start();
