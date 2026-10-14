import { uuidFrom } from './util.ts';

export type Kind = 'collection' | 'disbursement';

/**
 * The id a payment has at the provider (pawaPay's depositId / payoutId, a UUIDv4). It is a pure function of the tenant and the tenant's reference,
 * so a retry, a restart or a second gateway instance always arrives at the same id and the provider answers DUPLICATE_IGNORED instead of paying twice.
 *
 * A tenant migrated from a product that already used pawaPay directly carries its old `id_namespace`: its ids are then derived EXACTLY as that product
 * derived them (`<ns>-deposit:<reference>`, `<ns>-payout:<reference>`), so payments still in flight at the cutover keep resolving and their callbacks still match.
 * Every other tenant gets an id that includes the tenant, so two products can never collide on the same reference.
 */
export function providerIdFor(tenant: { id: string; id_namespace: string | null }, kind: Kind, reference: string): Promise<string> {
	if (tenant.id_namespace) return uuidFrom(`${tenant.id_namespace}-${kind === 'collection' ? 'deposit' : 'payout'}:${reference}`);
	return uuidFrom(`paygate:${tenant.id}:${kind}:${reference}`);
}
