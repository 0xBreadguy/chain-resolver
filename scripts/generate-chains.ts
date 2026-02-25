/**
 * Stage 2: Generate unified chain data from sources
 *
 * This script reads fetched source data, normalizes it, applies overrides,
 * and generates the raw chains file.
 *
 * Usage: npm run generate:chains
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import axios from "axios";
import { extname } from "path";
import { PATHS, SOURCE_FILES } from "./lib/constants.js";
import type {
  UnifiedChain,
  RoutescanResponse,
  RoutescanChain,
  ChainIdNetworkResponse,
  ViemChainData,
  OverridesFileV1,
  LegacyOverridesFile,
  ExcludesFile,
} from "./lib/types.js";
import {
  normalizeRoutescanChain,
  buildNormalizationContext,
} from "./lib/normalizers/evm.js";
import {
  getOverrides,
  getExcludes,
  applyOverrides,
  deduplicateChains,
  fixDuplicateLabels,
  sortChains,
  validateChains,
  toOutputChain,
} from "./lib/merger.js";

const AVATARS_DIR = PATHS.avatarsDir;

/**
 * Download and save avatar image
 */
async function downloadAvatar(
  logoUrl: string,
  label: string,
): Promise<string | null> {
  try {
    // Skip generic Routescan fallback logos
    if (logoUrl.includes("routescan-new")) {
      return null;
    }

    // Ensure avatars directory exists
    if (!existsSync(AVATARS_DIR)) {
      mkdirSync(AVATARS_DIR, { recursive: true });
    }

    // Download the image
    const response = await axios.get(logoUrl, {
      responseType: "arraybuffer",
      timeout: 10000,
    });

    // Determine file extension
    let ext = extname(new URL(logoUrl).pathname).toLowerCase();
    if (!ext || ext === "") {
      const contentType = response.headers["content-type"];
      if (contentType?.includes("image/png")) {
        ext = ".png";
      } else if (contentType?.includes("image/jpeg") || contentType?.includes("image/jpg")) {
        ext = ".jpg";
      } else if (contentType?.includes("image/svg")) {
        ext = ".svg";
      } else if (contentType?.includes("image/webp")) {
        ext = ".webp";
      } else {
        ext = ".png";
      }
    }

    const sanitizedLabel = label.replace(/[^a-z0-9-]/gi, "-");
    const filename = `${sanitizedLabel}-avatar${ext}`;
    const filepath = join(AVATARS_DIR, filename);

    writeFileSync(filepath, Buffer.from(response.data));
    return `${AVATARS_DIR}/${filename}`;
  } catch (error) {
    console.warn(`Failed to download avatar for ${label}:`, error instanceof Error ? error.message : error);
    return null;
  }
}

async function main() {
  console.log("Generating chain data from sources...\n");

  // Check that sources exist
  const mainnetPath = join(PATHS.sourcesEvm, SOURCE_FILES.routescanMainnets);
  const testnetPath = join(PATHS.sourcesEvm, SOURCE_FILES.routescanTestnets);
  const chainIdPath = join(PATHS.sourcesEvm, SOURCE_FILES.chainidNetwork);
  const viemPath = join(PATHS.sourcesEvm, SOURCE_FILES.viemChains);

  if (!existsSync(mainnetPath) || !existsSync(testnetPath)) {
    console.error("Source files not found. Run 'npm run fetch:sources' first.");
    process.exit(1);
  }

  // Load source data
  console.log("Loading source data...");
  const routescanMainnets: RoutescanResponse = JSON.parse(readFileSync(mainnetPath, "utf-8"));
  const routescanTestnets: RoutescanResponse = JSON.parse(readFileSync(testnetPath, "utf-8"));
  const chainIdNetwork: ChainIdNetworkResponse = existsSync(chainIdPath)
    ? JSON.parse(readFileSync(chainIdPath, "utf-8"))
    : [];
  const viemChains: ViemChainData[] = existsSync(viemPath)
    ? JSON.parse(readFileSync(viemPath, "utf-8"))
    : [];

  console.log(`  Routescan mainnets: ${routescanMainnets.items.length}`);
  console.log(`  Routescan testnets: ${routescanTestnets.items.length}`);
  console.log(`  chainid.network: ${chainIdNetwork.length}`);
  console.log(`  viem chains: ${viemChains.length}`);

  // Load overrides
  let overrides = new Map<string, import("./lib/types.js").ChainOverride>();
  if (existsSync(PATHS.overrides)) {
    const overridesContent = readFileSync(PATHS.overrides, "utf-8");
    const overridesFile: OverridesFileV1 | LegacyOverridesFile = JSON.parse(overridesContent);
    overrides = getOverrides(overridesFile);
    console.log(`  Overrides: ${overrides.size}`);
  }

  // Load excludes
  let excludes = new Set<string>();
  if (existsSync(PATHS.excludes)) {
    const excludesContent = readFileSync(PATHS.excludes, "utf-8");
    const excludesFile: ExcludesFile = JSON.parse(excludesContent);
    excludes = getExcludes(excludesFile);
    console.log(`  Excludes: ${excludes.size}`);
  }

  // Build testnet IDs set
  const testnetChainIds: number[] = [];
  for (const chain of routescanTestnets.items) {
    const id = Number(chain.evmChainId ?? chain.chainId);
    if (!Number.isNaN(id)) {
      testnetChainIds.push(id);
    }
  }

  // Build normalization context
  const ctx = buildNormalizationContext(chainIdNetwork, viemChains, testnetChainIds);

  // Normalize all Routescan chains
  console.log("\nNormalizing chains...");
  const allRoutescanChains: RoutescanChain[] = [
    ...routescanMainnets.items,
    ...routescanTestnets.items,
  ];

  let chains: UnifiedChain[] = allRoutescanChains.map((chain) =>
    normalizeRoutescanChain(chain, ctx),
  );

  // Filter excludes
  if (excludes.size > 0) {
    const beforeCount = chains.length;
    chains = chains.filter((c) => !excludes.has(c.caip2));
    console.log(`  Excluded ${beforeCount - chains.length} chains`);
  }

  // Deduplicate
  chains = deduplicateChains(chains);
  console.log(`  Deduplicated to ${chains.length} unique chains`);

  // Apply overrides
  chains = chains.map((chain) => {
    const override = overrides.get(chain.caip2);
    if (override) {
      return applyOverrides(chain, override);
    }
    return chain;
  });

  // Sort by chainId
  chains = sortChains(chains);

  // Fix duplicate labels
  chains = fixDuplicateLabels(chains);

  // Download avatars
  console.log("\nDownloading avatars...");
  let avatarCount = 0;
  for (const chain of chains) {
    const logoUrl = chain.textRecords["_logoUrl"];
    if (logoUrl) {
      const localPath = await downloadAvatar(logoUrl, chain.label);
      if (localPath) {
        chain.textRecords["avatar"] = localPath;
        avatarCount++;
      }
      // Remove internal field
      delete chain.textRecords["_logoUrl"];
    }
  }
  console.log(`  Downloaded ${avatarCount} avatars`);

  // Validate
  console.log("\nValidating chains...");
  const validation = validateChains(chains);

  if (validation.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of validation.warnings) {
      console.log(`  ⚠️  ${warning}`);
    }
  }

  if (!validation.valid) {
    console.error("\nErrors:");
    for (const error of validation.errors) {
      console.error(`  ❌ ${error}`);
    }
    console.error("\nValidation failed!");
    process.exit(1);
  }

  console.log("  ✅ All validations passed");

  // Ensure output directory exists
  if (!existsSync(PATHS.generated)) {
    mkdirSync(PATHS.generated, { recursive: true });
  }

  // Write raw chains (unified format)
  writeFileSync(PATHS.rawChains, JSON.stringify(chains, null, 2));
  console.log(`\n✓ Raw chains saved to ${PATHS.rawChains}`);

  // Also write backward-compatible format to chains.generated.json
  const outputChains = chains.map(toOutputChain);
  writeFileSync(PATHS.generatedChains, JSON.stringify(outputChains, null, 2));
  console.log(`✓ Generated chains saved to ${PATHS.generatedChains}`);

  console.log(`\nGeneration complete! ${chains.length} chains processed.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
