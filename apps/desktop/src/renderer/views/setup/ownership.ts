// Who owns the vaults Flow trades: the Flow wallet (vaults Flow created) or another wallet (e.g. the deployer, when
// the user picked "I already have vaults"). Only a vault's on-chain owner() can withdraw or resume it.

export interface VaultOwnerRow {
  address: string;
  owner?: string;
}

export interface Ownership {
  /** vault address (lowercase) → its on-chain owner, when it was read */
  byVault: Record<string, string>;
  /** distinct owners that are not the Flow wallet */
  foreign: string[];
  /** true when every vault read is owned by the Flow wallet (false while unknown) */
  allFlow: boolean;
}

const lc = (s: string) => s.toLowerCase();

export function vaultOwnership(flow: string | null | undefined, vaults: VaultOwnerRow[] | null | undefined): Ownership {
  const byVault: Record<string, string> = {};
  for (const v of vaults ?? []) if (v.owner) byVault[lc(v.address)] = v.owner;
  const owners = Object.values(byVault);
  const foreign = flow ? [...new Map(owners.filter((o) => lc(o) !== lc(flow)).map((o) => [lc(o), o])).values()] : [];
  return { byVault, foreign, allFlow: !!flow && owners.length > 0 && foreign.length === 0 };
}

/** The vault's owner when it is not the Flow wallet; null when the Flow wallet owns it or it is unknown. */
export function foreignOwnerOf(o: Ownership, flow: string | null | undefined, vault: string): string | null {
  const owner = o.byVault[lc(vault)];
  return owner && flow && lc(owner) !== lc(flow) ? owner : null;
}

/** "These vaults are owned by 0x… (another wallet). Only that wallet can withdraw or resume." */
export function foreignOwnerLine(foreign: string[]): string | null {
  if (!foreign.length) return null;
  return foreign.length === 1
    ? `These vaults are owned by ${foreign[0]} (another wallet). Only that wallet can withdraw or resume.`
    : `These vaults are owned by other wallets (${foreign.join(", ")}). Only those wallets can withdraw or resume.`;
}
