import { createPawapay, type PawapayDeps } from './pawapay.ts';
import { sandboxCollect, sandboxDisburse } from './sandbox.ts';
import { on } from '../util.ts';
import type { Providers } from './types.ts';

/**
 * Picks the money providers from PROVIDER_MODE. The sandbox pretends to move money, so it can never run with LIVE=true; pawaPay refuses unsafe
 * combinations itself (its sandbox URL with LIVE=true, its production URL without it).
 */
export function getProviders(env: Env, deps: PawapayDeps = {}): Providers {
	const mode = env.PROVIDER_MODE || 'sandbox';
	if (mode === 'sandbox') {
		if (on(env.LIVE)) throw new Error('PROVIDER_MODE=sandbox cannot be used with LIVE=true');
		return { mode, collect: sandboxCollect, disburse: sandboxDisburse, parseCallback: async () => null }; // the sandbox has no callbacks
	}
	if (mode === 'pawapay') {
		const p = createPawapay(env, { cache: env.CACHE, ...deps });
		return { mode, collect: p.collect, disburse: p.disburse, parseCallback: p.parseCallback };
	}
	throw new Error(`Unknown PROVIDER_MODE "${mode}"`);
}
