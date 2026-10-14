/**
 * How a tenant checks that an event really came from the gateway. Header `Paygate-Signature: t=<unix seconds>,v1=<hex>` where v1 is the
 * HMAC-SHA256 of `<t>.<raw body>` under the tenant's webhook secret. Reject anything older than a few minutes (replay) and compare in constant time.
 * Import-free apart from util.ts, so a product can copy this file as it is.
 */
import { hmacHex, safeEqual } from './util.ts';

export async function signBody(secret: string, body: string, t: number): Promise<string> {
	return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

export async function verifySignature(secret: string, body: string, header: string | null, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): Promise<boolean> {
	const m = /^t=(\d{9,12}),v1=([0-9a-f]{64})$/.exec((header ?? '').trim());
	if (!m) return false;
	if (Math.abs(nowSeconds - Number(m[1])) > toleranceSeconds) return false;
	return safeEqual(m[2]!, await hmacHex(secret, `${m[1]}.${body}`));
}
