const enc = new TextEncoder();

export const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(s: string): Promise<string> {
	return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Constant-time comparison. */
export function safeEqual(a: string, b: string): boolean {
	const x = enc.encode(a), y = enc.encode(b);
	let d = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return d === 0;
}

/** A random id with a readable prefix: `pg` + 18 hex = 20 characters, short enough to be a PI-SPI transaction id. */
export function newId(prefix: string, bytes = 9): string {
	return prefix + hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A deterministic UUIDv4-shaped id from a string (pawaPay wants a UUIDv4 and the same input must always give the same id). */
export async function uuidFrom(input: string): Promise<string> {
	const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input))).slice(0, 16);
	h[6] = (h[6]! & 0x0f) | 0x40; // version 4
	h[8] = (h[8]! & 0x3f) | 0x80; // variant 10xx
	const x = hex(h);
	return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ msg, ...extra }));

/** Stable JSON (sorted keys), so the same request always hashes the same. */
export function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
	if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
	return JSON.stringify(v);
}

/** An absolute https URL (or http on localhost outside LIVE) and nothing else: these end up in links customers tap and in webhook targets. */
export function safeUrl(v: unknown, opts: { allowLocalHttp?: boolean } = {}): string | null {
	if (typeof v !== 'string' || v.length > 2048) return null;
	try {
		const u = new URL(v);
		if (u.protocol === 'https:') return v;
		if (opts.allowLocalHttp && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return v;
		return null;
	} catch { return null; }
}

/** A "true" switch from the Worker's vars. (The generated Env types narrow each var to its literal value, so `=== 'true'` would not compile for a var set to "false".) */
export const on = (v: string | undefined): boolean => v === 'true';
