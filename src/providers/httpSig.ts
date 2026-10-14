/**
 * RFC 9421 HTTP message signatures, as pawaPay signs its callbacks (ECDSA P-256 / P-384). Import-free, so it is unit-tested in plain Node.
 * A callback is accepted only if the body digest matches, the signature covers the method, path and digest, it is fresh, and it verifies against the key.
 */
import { safeEqual } from '../util.ts';

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const B64 = (u: Uint8Array) => { let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); };

export interface SigParams { label: string; components: string[]; raw: string; alg: string; keyid: string; created: number; expires?: number }

/** Parses `Signature-Input: sig-pp=("@method" "content-digest");alg="ecdsa-p256-sha256";keyid="K";created=1;expires=2`. */
export function parseSignatureInput(header: string): SigParams | null {
	const m = /^([A-Za-z0-9_-]+)=\(([^)]*)\)((?:;[^;]+)*)$/.exec(header.trim());
	if (!m) return null;
	const params = Object.fromEntries([...m[3]!.matchAll(/;([a-z]+)=("[^"]*"|\d+)/g)].map((p) => [p[1]!, p[2]!.replace(/^"|"$/g, '')]));
	const components = [...m[2]!.matchAll(/"([^"]+)"/g)].map((c) => c[1]!);
	if (!params.alg || !params.keyid || !params.created || components.length === 0) return null;
	return { label: m[1]!, components, raw: `(${m[2]})${m[3]}`, alg: params.alg, keyid: params.keyid, created: Number(params.created), expires: params.expires ? Number(params.expires) : undefined };
}

/** The signature base: one line per covered component, then the signature parameters. */
export function signatureBase(p: SigParams, req: { method: string; url: URL; headers: Headers }): string | null {
	const lines: string[] = [];
	for (const c of p.components) {
		let v: string | null;
		if (c === '@method') v = req.method.toUpperCase();
		else if (c === '@authority') v = req.url.host.toLowerCase();
		else if (c === '@path') v = req.url.pathname;
		else if (c === '@scheme') v = req.url.protocol.replace(':', '');
		else if (c === '@query') v = req.url.search || '?';
		else if (c === '@target-uri') v = req.url.href;
		else if (c.startsWith('@')) return null; // a derived component we don't implement: refuse rather than guess
		else v = req.headers.get(c);
		if (v === null) return null;
		lines.push(`"${c}": ${v.trim()}`);
	}
	lines.push(`"@signature-params": ${p.raw}`);
	return lines.join('\n');
}

const ALGS: Record<string, { import: { name: string; namedCurve: string }; verify: { name: string; hash: string } }> = {
	'ecdsa-p256-sha256': { import: { name: 'ECDSA', namedCurve: 'P-256' }, verify: { name: 'ECDSA', hash: 'SHA-256' } },
	'ecdsa-p384-sha384': { import: { name: 'ECDSA', namedCurve: 'P-384' }, verify: { name: 'ECDSA', hash: 'SHA-384' } },
};

/** `Content-Digest: sha-512=:base64:` must match the body. */
export async function digestMatches(header: string | null, body: string): Promise<boolean> {
	const m = /^(sha-256|sha-512)=:([A-Za-z0-9+/=]+):$/.exec((header ?? '').trim());
	if (!m) return false;
	const h = await crypto.subtle.digest(m[1] === 'sha-512' ? 'SHA-512' : 'SHA-256', new TextEncoder().encode(body));
	return safeEqual(B64(new Uint8Array(h)), m[2]!);
}

const pemToDer = (pem: string) => b64(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));

export type KeyFetcher = (keyid: string) => Promise<string | null>;

export async function verifyCallback(req: { method: string; url: URL; headers: Headers; body: string }, getKey: KeyFetcher, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): Promise<boolean> {
	const sigInput = req.headers.get('signature-input'), sigHeader = req.headers.get('signature');
	if (!sigInput || !sigHeader) return false;
	const p = parseSignatureInput(sigInput);
	if (!p) return false;
	// the body must be covered, or a valid signature could be reused with a different body
	if (!p.components.includes('content-digest') || !p.components.includes('@method') || !p.components.includes('@path')) return false;
	const alg = ALGS[p.alg];
	if (!alg) return false;
	if (Math.abs(nowSeconds - p.created) > toleranceSeconds) return false; // replay protection
	if (p.expires !== undefined && nowSeconds > p.expires + 60) return false;
	if (!(await digestMatches(req.headers.get('content-digest'), req.body))) return false;
	const sm = new RegExp(`(?:^|,\\s*)${p.label}=:([A-Za-z0-9+/=]+):`).exec(sigHeader);
	if (!sm) return false;
	const base = signatureBase(p, req);
	const pem = base ? await getKey(p.keyid) : null;
	if (!base || !pem) return false;
	try {
		const key = await crypto.subtle.importKey('spki', pemToDer(pem), alg.import, false, ['verify']);
		return await crypto.subtle.verify(alg.verify, key, b64(sm[1]!), new TextEncoder().encode(base));
	} catch { return false; }
}
