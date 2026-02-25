/**
 * Stage 3: Generate diff between raw and approved chains
 *
 * This script compares the newly generated raw chains against the
 * approved chains and generates a diff report for human review.
 *
 * Usage: npm run diff:chains
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { PATHS } from "./lib/constants.js";
import type { UnifiedChain, OutputChain } from "./lib/types.js";
import { generateDiff, formatDiffMarkdown, printDiffConsole } from "./lib/differ.js";

/**
 * Convert OutputChain to UnifiedChain format for comparison
 */
function outputToUnified(chain: OutputChain): UnifiedChain {
  const chainIdMatch = chain.textRecords["chainId"]?.match(/^eip155:(\d+)$/);
  const reference = chainIdMatch ? chainIdMatch[1] : "0";

  return {
    namespace: "eip155",
    reference,
    caip2: chain.textRecords["chainId"] || `eip155:${reference}`,
    label: chain.label,
    name: chain.chainName,
    aliases: chain.aliases || [],
    interoperableAddress: chain.interoperableAddressHex,
    isTestnet: chain.textRecords["isTestnet"] === "true",
    textRecords: chain.textRecords,
    _sources: [],
  };
}

async function main() {
  console.log("Generating chain diff report...\n");

  // Check that raw chains exist
  if (!existsSync(PATHS.rawChains)) {
    console.error(`Raw chains not found at ${PATHS.rawChains}`);
    console.error("Run 'npm run generate:chains' first.");
    process.exit(1);
  }

  // Load raw chains
  const rawChains: UnifiedChain[] = JSON.parse(readFileSync(PATHS.rawChains, "utf-8"));
  console.log(`Loaded ${rawChains.length} raw chains`);

  // Load approved chains (or create empty if doesn't exist)
  let approvedChains: UnifiedChain[] = [];

  if (existsSync(PATHS.approvedChains)) {
    // Try to load as UnifiedChain[] first
    const content = readFileSync(PATHS.approvedChains, "utf-8");
    const parsed = JSON.parse(content);

    // Check if it's the new format or legacy OutputChain format
    if (Array.isArray(parsed) && parsed.length > 0) {
      if ("namespace" in parsed[0]) {
        // New UnifiedChain format
        approvedChains = parsed;
      } else if ("chainName" in parsed[0]) {
        // Legacy OutputChain format
        approvedChains = parsed.map(outputToUnified);
      }
    }
    console.log(`Loaded ${approvedChains.length} approved chains`);
  } else if (existsSync(PATHS.generatedChains)) {
    // If no approved file exists but we have generated chains, use those
    console.log("No approved chains found. Using generated chains as baseline...");
    const generated: OutputChain[] = JSON.parse(readFileSync(PATHS.generatedChains, "utf-8"));
    approvedChains = generated.map(outputToUnified);
    console.log(`Loaded ${approvedChains.length} chains from generated file`);
  } else {
    console.log("No approved or generated chains found. All chains will show as added.");
  }

  // Generate diff
  const diff = generateDiff(rawChains, approvedChains);

  // Print to console
  printDiffConsole(diff);

  // Write markdown report
  const markdown = formatDiffMarkdown(diff);
  writeFileSync(PATHS.diffReport, markdown);
  console.log(`\n✓ Diff report saved to ${PATHS.diffReport}`);

  // Summary
  const totalChanges = diff.summary.added + diff.summary.removed + diff.summary.modified;
  if (totalChanges === 0) {
    console.log("\n✅ No changes detected. Raw chains match approved chains.");
  } else {
    console.log(`\n⚠️  ${totalChanges} change(s) detected.`);
    console.log("Review the diff report and update chains.approved.json to approve changes.");
    console.log("\nTo approve all changes:");
    console.log(`  cp ${PATHS.rawChains} ${PATHS.approvedChains}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
