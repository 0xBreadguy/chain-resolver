// Shared chain registration data
// Used by both tests and deployment scripts
// This file imports the approved chain data from chains.approved.json
// For backward compatibility, falls back to chains.generated.json

import approvedChains from "./chains.approved.json";

export interface ChainData {
  // The canonical label (e.g., "optimism")
  label: string;
  // The display name (e.g., "OP Mainnet")
  chainName: string;
  // The ERC-7930 interoperable address as hex string
  interoperableAddressHex: string;
  // Optional aliases that point to this chain (e.g., ["op"] for optimism)
  aliases?: string[];
  // Optional owner address - defaults to contract owner during registration
  owner?: string;
  // Optional text records
  textRecords?: Record<string, string>;
  contenthash?: string;
}

// List of Chains to register - imported from approved JSON
// Run the pipeline to regenerate:
//   npm run fetch:sources    # Stage 1: Fetch from APIs
//   npm run generate:chains  # Stage 2: Generate raw chains
//   npm run diff:chains      # Stage 3: Review changes
// Then copy raw to approved: cp data/generated/chains.raw.json data/chains.approved.json
export const CHAINS: ChainData[] = approvedChains as unknown as ChainData[];

// Helper to get a chain by label
export function getChainByLabel(label: string): ChainData | undefined {
  return CHAINS.find((c) => c.label === label);
}

// Helper to get a chain by alias
export function getChainByAlias(alias: string): ChainData | undefined {
  return CHAINS.find((c) => c.aliases?.includes(alias));
}

// Helper to get all aliases across all chains
export function getAllAliases(): { alias: string; canonicalLabel: string }[] {
  const result: { alias: string; canonicalLabel: string }[] = [];
  for (const chain of CHAINS) {
    for (const alias of chain.aliases || []) {
      result.push({ alias, canonicalLabel: chain.label });
    }
  }
  return result;
}

