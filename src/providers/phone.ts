/** Operator + number -> provider code, per country. Moov is not offered in Côte d'Ivoire, Wave not in Burkina Faso, and pawaPay has no PI-SPI. */
const COUNTRY_BY_DIAL: Record<string, string> = { '225': 'CIV', '221': 'SEN', '226': 'BFA' };
const PROVIDERS: Record<string, Record<string, string>> = {
	CIV: { orange: 'ORANGE_CIV', wave: 'WAVE_CIV' },
	SEN: { orange: 'ORANGE_SEN', wave: 'WAVE_SEN' },
	BFA: { orange: 'ORANGE_BFA', moov: 'MOOV_BFA' },
};
export const OPERATORS = new Set(['orange', 'wave', 'moov']);
export const COUNTRIES = ['CIV', 'SEN', 'BFA'];

/** "+2250789458900" -> { msisdn: "2250789458900", country: "CIV" }, or null for an unsupported country. */
export function parsePhone(e164: string): { msisdn: string; country: string } | null {
	const m = /^\+(\d{8,15})$/.exec(e164);
	if (!m) return null;
	const digits = m[1]!;
	const country = COUNTRY_BY_DIAL[digits.slice(0, 3)];
	return country ? { msisdn: digits, country } : null;
}

export function providerCode(operator: string, phone: string): string | null {
	const p = parsePhone(phone);
	return p ? (PROVIDERS[p.country]?.[operator] ?? null) : null;
}
