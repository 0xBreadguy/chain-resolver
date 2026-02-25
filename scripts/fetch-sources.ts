/**
 * Stage 1: Fetch source data from external APIs
 *
 * This script fetches chain data from multiple sources and saves them
 * as raw JSON files in data/sources/evm/.
 *
 * Usage: npm run fetch:sources
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { PATHS, SOURCE_FILES } from "./lib/constants.js";
import {
  fetchRoutescanMainnets,
  fetchRoutescanTestnets,
  fetchChainIdNetwork,
  fetchViemChains,
} from "./lib/fetchers/index.js";
import type { SourceManifest, SourceFetchRecord } from "./lib/types.js";
import { formatTimestamp } from "./lib/utils.js";

async function main() {
  console.log("Fetching chain data from external sources...\n");

  // Ensure source directories exist
  if (!existsSync(PATHS.sourcesEvm)) {
    mkdirSync(PATHS.sourcesEvm, { recursive: true });
  }

  const sources: SourceFetchRecord[] = [];

  // Fetch Routescan mainnets
  console.log("Fetching Routescan mainnets...");
  try {
    const routescanMainnets = await fetchRoutescanMainnets();
    const mainnetPath = join(PATHS.sourcesEvm, SOURCE_FILES.routescanMainnets);
    writeFileSync(mainnetPath, JSON.stringify(routescanMainnets.data, null, 2));
    console.log(`  ✓ ${routescanMainnets.data.items.length} chains saved to ${mainnetPath}`);
    sources.push({
      source: "routescan-mainnets",
      fetchedAt: formatTimestamp(routescanMainnets.fetchedAt),
      itemCount: routescanMainnets.data.items.length,
    });
  } catch (error) {
    console.error("  ✗ Failed to fetch Routescan mainnets:", error);
    throw error;
  }

  // Fetch Routescan testnets
  console.log("Fetching Routescan testnets...");
  try {
    const routescanTestnets = await fetchRoutescanTestnets();
    const testnetPath = join(PATHS.sourcesEvm, SOURCE_FILES.routescanTestnets);
    writeFileSync(testnetPath, JSON.stringify(routescanTestnets.data, null, 2));
    console.log(`  ✓ ${routescanTestnets.data.items.length} chains saved to ${testnetPath}`);
    sources.push({
      source: "routescan-testnets",
      fetchedAt: formatTimestamp(routescanTestnets.fetchedAt),
      itemCount: routescanTestnets.data.items.length,
    });
  } catch (error) {
    console.error("  ✗ Failed to fetch Routescan testnets:", error);
    throw error;
  }

  // Fetch chainid.network
  console.log("Fetching chainid.network...");
  try {
    const chainIdNetwork = await fetchChainIdNetwork();
    const chainIdPath = join(PATHS.sourcesEvm, SOURCE_FILES.chainidNetwork);
    writeFileSync(chainIdPath, JSON.stringify(chainIdNetwork.data, null, 2));
    console.log(`  ✓ ${chainIdNetwork.data.length} chains saved to ${chainIdPath}`);
    sources.push({
      source: "chainid-network",
      fetchedAt: formatTimestamp(chainIdNetwork.fetchedAt),
      itemCount: chainIdNetwork.data.length,
    });
  } catch (error) {
    console.error("  ✗ Failed to fetch chainid.network:", error);
    throw error;
  }

  // Extract viem chains
  console.log("Extracting viem chains...");
  try {
    const viemResult = fetchViemChains();
    const viemPath = join(PATHS.sourcesEvm, SOURCE_FILES.viemChains);
    // Only save the chains array (not the maps which can't be serialized)
    writeFileSync(viemPath, JSON.stringify(viemResult.data.chains, null, 2));
    console.log(`  ✓ ${viemResult.data.chains.length} chains saved to ${viemPath}`);
    sources.push({
      source: "viem",
      fetchedAt: formatTimestamp(viemResult.fetchedAt),
      itemCount: viemResult.data.chains.length,
    });
  } catch (error) {
    console.error("  ✗ Failed to extract viem chains:", error);
    throw error;
  }

  // Write manifest
  const manifest: SourceManifest = {
    version: 1,
    lastUpdated: formatTimestamp(),
    sources,
  };
  writeFileSync(PATHS.manifest, JSON.stringify(manifest, null, 2));
  console.log(`\n✓ Manifest saved to ${PATHS.manifest}`);

  console.log("\nFetch complete!");
  console.log(`  Sources fetched: ${sources.length}`);
  console.log(`  Total chains: ${sources.reduce((acc, s) => acc + s.itemCount, 0)}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
