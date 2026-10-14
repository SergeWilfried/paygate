/**
 * Operational alerts for things a person must look at: a payout with an unknown outcome, a payment that arrived for the wrong amount, a webhook that
 * could not be delivered, a wallet running dry. Always written to the Worker log as an `alert` line; also POSTed to ALERT_WEBHOOK_URL when set (the
 * body carries both `text` for Slack and `content` for Discord). An alert can never break the operation that raised it: failures are logged and swallowed.
 * No customer data goes out: payment ids, tenants, amounts and codes only.
 */
export type AlertLevel = 'critical' | 'warning' | 'info';
export interface AlertInput { level: AlertLevel; title: string; details?: Record<string, string | number | boolean | null | undefined> }

const ICON: Record<AlertLevel, string> = { critical: '🔴', warning: '🟠', info: 'ℹ️' };

export function formatAlert(a: AlertInput): string {
	const lines = Object.entries(a.details ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${v}`);
	return [`${ICON[a.level]} Paygate: ${a.title}`, ...lines].join('\n');
}

export async function alert(env: Env, a: AlertInput): Promise<void> {
	const text = formatAlert(a);
	console.error(JSON.stringify({ msg: 'alert', level: a.level, title: a.title, ...a.details }));
	const url = env.ALERT_WEBHOOK_URL;
	if (!url) return;
	try {
		const res = await fetch(url, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ text, content: text, level: a.level, title: a.title, details: a.details ?? {} }),
			signal: AbortSignal.timeout(3000),
		});
		if (!res.ok) console.error(JSON.stringify({ msg: 'alert.webhook_rejected', status: res.status }));
	} catch (e) { console.error(JSON.stringify({ msg: 'alert.webhook_failed', error: e instanceof Error ? e.message : String(e) })); }
}
