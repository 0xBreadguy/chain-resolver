/**
 * Interactive Chain Approval Script
 *
 * Allows users to search, review, validate, and approve chains
 * from chains.raw.json into chains.approved.json
 *
 * Usage: npm run approve:chains
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { exec } from "child_process";
import { input, select, confirm, checkbox } from "@inquirer/prompts";
import chalk from "chalk";
import ora from "ora";
import "dotenv/config";

import { PATHS } from "./lib/constants.js";
import type {
  UnifiedChain,
  ApprovedChain,
  ExcludesFile,
  ValidationResult,
} from "./lib/types.js";
import { validateAllUrls, validateUrl, getFormatValidation, isValidUrlFormat } from "./lib/validators.js";
import {
  isPinataConfigured,
  uploadChainImages,
  getFileSize,
  isFileSizeLarge,
  testPinataConnection,
} from "./lib/pinata.js";

// ============================================================================
// Data Loading
// ============================================================================

function loadRawChains(): UnifiedChain[] {
  if (!existsSync(PATHS.rawChains)) {
    console.error(
      chalk.red("Raw chains file not found. Run 'npm run generate:chains' first.")
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(PATHS.rawChains, "utf-8"));
}

function loadApprovedChains(): ApprovedChain[] {
  if (!existsSync(PATHS.approvedChains)) {
    return [];
  }
  return JSON.parse(readFileSync(PATHS.approvedChains, "utf-8"));
}

function loadExcludes(): ExcludesFile {
  if (!existsSync(PATHS.excludes)) {
    return { version: 1, chains: [] };
  }
  return JSON.parse(readFileSync(PATHS.excludes, "utf-8"));
}

function loadDrafts(): Map<string, Partial<UnifiedChain>> {
  if (!existsSync(PATHS.chainDrafts)) {
    return new Map();
  }
  const data = JSON.parse(readFileSync(PATHS.chainDrafts, "utf-8"));
  return new Map(Object.entries(data));
}

function saveDrafts(drafts: Map<string, Partial<UnifiedChain>>): void {
  const obj = Object.fromEntries(drafts);
  writeFileSync(PATHS.chainDrafts, JSON.stringify(obj, null, 2));
}

function saveDraft(drafts: Map<string, Partial<UnifiedChain>>, chain: UnifiedChain): void {
  drafts.set(chain.caip2, {
    label: chain.label,
    name: chain.name,
    aliases: chain.aliases,
    textRecords: chain.textRecords,
  });
  saveDrafts(drafts);
}

function removeDraft(drafts: Map<string, Partial<UnifiedChain>>, caip2: string): void {
  drafts.delete(caip2);
  saveDrafts(drafts);
}

function applyDraft(chain: UnifiedChain, draft: Partial<UnifiedChain>): UnifiedChain {
  return {
    ...chain,
    label: draft.label ?? chain.label,
    name: draft.name ?? chain.name,
    aliases: draft.aliases ?? chain.aliases,
    textRecords: draft.textRecords ?? chain.textRecords,
  };
}

function saveApprovedChains(chains: ApprovedChain[]): void {
  writeFileSync(PATHS.approvedChains, JSON.stringify(chains, null, 2));
}

function saveExcludes(excludes: ExcludesFile): void {
  writeFileSync(PATHS.excludes, JSON.stringify(excludes, null, 2));
}

// ============================================================================
// Chain Conversion
// ============================================================================

function toApprovedChain(chain: UnifiedChain): ApprovedChain {
  // Copy textRecords and remove internal path fields (not for on-chain storage)
  const { avatarPath, headerPath, ...cleanTextRecords } = chain.textRecords;

  // Ensure chainId is present
  const textRecords = {
    chainId: chain.caip2,
    ...cleanTextRecords,
  };

  return {
    label: chain.label,
    chainName: chain.name,
    interoperableAddressHex: chain.interoperableAddress,
    aliases: chain.aliases,
    textRecords,
    _approvedAt: new Date().toISOString(),
    _approvedFrom: chain.caip2,
  };
}

// ============================================================================
// Display Functions
// ============================================================================

function displayChainSummary(chain: UnifiedChain): void {
  console.log();
  console.log(chalk.bold.cyan("═".repeat(60)));
  console.log(chalk.bold.cyan(`  ${chain.name}`));
  console.log(chalk.bold.cyan("═".repeat(60)));
  console.log();

  console.log(chalk.gray("Basic Info:"));
  console.log(`  ${chalk.white("Label:")}     ${chalk.yellow(chain.label)}`);
  console.log(`  ${chalk.white("CAIP-2:")}    ${chalk.gray(chain.caip2)}`);
  console.log(`  ${chalk.white("Chain ID:")} ${chalk.gray(chain.reference)}`);
  console.log(
    `  ${chalk.white("Testnet:")}  ${chain.isTestnet ? chalk.yellow("Yes") : chalk.green("No")}`
  );

  if (chain.aliases.length > 0) {
    console.log(
      `  ${chalk.white("Aliases:")}  ${chalk.gray(chain.aliases.join(", "))}`
    );
  }

  console.log();
  console.log(chalk.gray("Text Records:"));
  // Skip internal fields and image paths (shown separately in displayImageStatus)
  // Also skip legacy field names
  const excludeKeys = ["chainId", "isTestnet", "avatarPath", "headerPath", "avatarIpfs", "headerIpfs"];
  for (const [key, value] of Object.entries(chain.textRecords)) {
    if (!excludeKeys.includes(key) && !key.startsWith("_")) {
      const displayValue =
        value && value.length > 50 ? value.substring(0, 47) + "..." : value;
      console.log(`  ${chalk.white(key + ":")} ${chalk.gray(displayValue ?? "")}`);
    }
  }
}

function displayValidationResults(results: ValidationResult[]): void {
  if (results.length === 0) {
    console.log(chalk.gray("  No URLs to validate"));
    return;
  }

  console.log();
  console.log(chalk.gray("URL Validation:"));

  for (const result of results) {
    const icon = result.valid ? chalk.green("✓") : chalk.red("✗");
    const status = result.statusCode
      ? chalk.gray(`[${result.statusCode}]`)
      : result.error
        ? chalk.red(`[${result.error}]`)
        : "";

    console.log(`  ${icon} ${chalk.white(result.field)}: ${status}`);

    if (result.redirectUrl) {
      console.log(chalk.yellow(`    ⚠ Redirects to: ${result.redirectUrl}`));
    }

    // Check format validation
    const formatCheck = getFormatValidation(result.field, result.url);
    if (!formatCheck.valid && formatCheck.warning) {
      console.log(chalk.yellow(`    ⚠ ${formatCheck.warning}`));
    }
  }
}

/**
 * Get the local path for avatar/header (checks both avatarPath and legacy avatar field)
 */
function getLocalImagePath(textRecords: Record<string, string | undefined>, type: "avatar" | "header"): string | undefined {
  const pathKey = type === "avatar" ? "avatarPath" : "headerPath";
  const path = textRecords[pathKey];
  if (path) return path;

  // Fall back to avatar/header if it's a local path (not ipfs://)
  const legacyPath = textRecords[type];
  if (legacyPath && !legacyPath.startsWith("ipfs://")) {
    return legacyPath;
  }
  return undefined;
}

/**
 * Get the IPFS URL for avatar/header
 */
function getIpfsUrl(textRecords: Record<string, string | undefined>, type: "avatar" | "header"): string | undefined {
  const url = textRecords[type];
  if (url && url.startsWith("ipfs://")) {
    return url;
  }
  return undefined;
}

function displayImageStatus(chain: UnifiedChain): void {
  console.log();
  console.log(chalk.gray("Images:"));

  const avatarPath = getLocalImagePath(chain.textRecords, "avatar");
  const avatarIpfs = getIpfsUrl(chain.textRecords, "avatar");
  const headerPath = getLocalImagePath(chain.textRecords, "header");
  const headerIpfs = getIpfsUrl(chain.textRecords, "header");

  // Avatar status
  if (avatarIpfs) {
    console.log(`  ${chalk.green("✓")} Avatar IPFS: ${chalk.cyan(avatarIpfs)}`);
  }
  if (avatarPath) {
    const exists = existsSync(avatarPath);
    const icon = exists ? chalk.green("✓") : chalk.red("✗");
    const status = exists
      ? chalk.gray(`(${getFileSize(avatarPath)})`)
      : chalk.red("MISSING");
    const warning = exists && isFileSizeLarge(avatarPath) ? chalk.yellow(" ⚠ Large file") : "";
    console.log(`  ${icon} Avatar path: ${chalk.white(avatarPath)} ${status}${warning}`);
  } else if (!avatarIpfs) {
    console.log(`  ${chalk.gray("-")} Avatar: ${chalk.gray("Not set")}`);
  }

  // Header status
  if (headerIpfs) {
    console.log(`  ${chalk.green("✓")} Header IPFS: ${chalk.cyan(headerIpfs)}`);
  }
  if (headerPath) {
    const exists = existsSync(headerPath);
    const icon = exists ? chalk.green("✓") : chalk.red("✗");
    const status = exists
      ? chalk.gray(`(${getFileSize(headerPath)})`)
      : chalk.red("MISSING");
    const warning = exists && isFileSizeLarge(headerPath) ? chalk.yellow(" ⚠ Large file") : "";
    console.log(`  ${icon} Header path: ${chalk.white(headerPath)} ${status}${warning}`);
  } else if (!headerIpfs) {
    console.log(`  ${chalk.gray("-")} Header: ${chalk.gray("Not set")}`);
  }
}

// ============================================================================
// Search Functions
// ============================================================================

function searchChains(chains: UnifiedChain[], query: string): UnifiedChain[] {
  const lowerQuery = query.toLowerCase();
  return chains.filter((chain) => {
    return (
      chain.label.toLowerCase().includes(lowerQuery) ||
      chain.name.toLowerCase().includes(lowerQuery) ||
      chain.aliases.some((alias) => alias.toLowerCase().includes(lowerQuery)) ||
      chain.reference === query ||
      chain.caip2.toLowerCase().includes(lowerQuery)
    );
  });
}

// ============================================================================
// Edit Functions
// ============================================================================

async function editChainFields(chain: UnifiedChain): Promise<UnifiedChain> {
  while (true) {
    // Get local paths and IPFS URLs for images
    const avatarPath = getLocalImagePath(chain.textRecords, "avatar") ?? "";
    const avatarIpfs = getIpfsUrl(chain.textRecords, "avatar") ?? "";
    const headerPath = getLocalImagePath(chain.textRecords, "header") ?? "";
    const headerIpfs = getIpfsUrl(chain.textRecords, "header") ?? "";

    // Get status for local path fields
    const getPathStatus = (path: string, ipfs: string) => {
      if (ipfs) return "✓ uploaded";
      if (!path) return "⚠ recommended";
      return existsSync(path) ? "✓" : "✗ NOT FOUND";
    };

    // Get other text records excluding image fields (including legacy field names)
    const imageFields = ["avatar", "avatarPath", "avatarIpfs", "header", "headerPath", "headerIpfs"];
    const otherTextRecords = Object.entries(chain.textRecords)
      .filter(([key]) => !key.startsWith("_") && !imageFields.includes(key))
      .map(([key, value]) => ({ name: `textRecords.${key}`, value: value ?? "" }));

    const editableFields = [
      { name: "label", value: chain.label },
      { name: "name (chainName)", value: chain.name },
      { name: "aliases", value: chain.aliases.join(", ") },
      // Image fields - show path for editing, IPFS status
      {
        name: "textRecords.avatarPath",
        value: avatarPath,
        status: getPathStatus(avatarPath, avatarIpfs)
      },
      {
        name: "textRecords.headerPath",
        value: headerPath,
        status: getPathStatus(headerPath, headerIpfs)
      },
      ...otherTextRecords,
    ];

    const choices = [
      ...editableFields.map((f: { name: string; value: string; status?: string }) => {
        let statusStr = "";
        if (f.status) {
          if (f.status === "✓") {
            statusStr = ` ${chalk.green(f.status)}`;
          } else if (f.status.includes("recommended")) {
            statusStr = ` ${chalk.yellow(f.status)}`;
          } else {
            statusStr = ` ${chalk.red(f.status)}`;
          }
        }
        const valueStr = f.value.length > 35 ? f.value.substring(0, 32) + "..." : f.value || chalk.gray("(not set)");
        return {
          name: `${f.name}: ${valueStr}${statusStr}`,
          value: f.name,
        };
      }),
      { name: chalk.cyan("+ Add new text record"), value: "__add__" },
      { name: chalk.gray("← Done editing"), value: "__done__" },
    ];

    const fieldName = await select({
      message: "Select field to edit:",
      choices,
      loop: false,
    });

    if (fieldName === "__done__") {
      break;
    }

    if (fieldName === "__add__") {
      const newKey = await input({
        message: "New text record key:",
      });
      if (newKey.trim()) {
        const newValue = await input({
          message: "New text record value:",
        });
        if (newValue.trim()) {
          chain.textRecords[newKey.trim()] = newValue.trim();
          // Validate if it's a URL
          if (isValidUrlFormat(newValue.trim())) {
            await validateAndDisplayUrl(newKey.trim(), newValue.trim());
          }
        }
      }
      continue;
    }

    if (fieldName === "label") {
      chain.label = await input({
        message: "New label:",
        default: chain.label,
      });
    } else if (fieldName === "name (chainName)") {
      chain.name = await input({
        message: "New name:",
        default: chain.name,
      });
    } else if (fieldName === "aliases") {
      const aliasStr = await input({
        message: "New aliases (comma-separated):",
        default: chain.aliases.join(", "),
      });
      chain.aliases = aliasStr
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
    } else if (fieldName.startsWith("textRecords.")) {
      const key = fieldName.replace("textRecords.", "");
      // For avatarPath/headerPath, use the helper to find the current value
      let currentValue: string;
      if (key === "avatarPath") {
        currentValue = getLocalImagePath(chain.textRecords, "avatar") ?? "";
      } else if (key === "headerPath") {
        currentValue = getLocalImagePath(chain.textRecords, "header") ?? "";
      } else {
        currentValue = chain.textRecords[key] ?? "";
      }
      const newValue = await input({
        message: `New value for ${key}:`,
        default: currentValue,
      });
      if (newValue.trim() === "") {
        delete chain.textRecords[key];
        if (key === "avatarPath" || key === "headerPath") {
          console.log(chalk.yellow(`  Removed ${key} (recommended field)`));
        } else {
          console.log(chalk.yellow(`  Removed ${key}`));
        }
      } else {
        chain.textRecords[key] = newValue;
        // Validate image paths exist and clear IPFS URL if path changed
        if (key === "avatarPath" || key === "headerPath") {
          // Clear IPFS URL since path changed - will need re-upload
          const ipfsKey = key === "avatarPath" ? "avatar" : "header";
          if (chain.textRecords[ipfsKey]?.startsWith("ipfs://")) {
            delete chain.textRecords[ipfsKey];
            console.log(chalk.yellow(`  Cleared ${ipfsKey} IPFS URL - will need to re-upload`));
          }
          if (existsSync(newValue)) {
            console.log(chalk.green(`  ✓ ${key}: File exists`));
          } else {
            console.log(chalk.red(`  ✗ ${key}: File not found at ${newValue}`));
          }
        }
        // Validate if it's a URL
        else if (isValidUrlFormat(newValue)) {
          await validateAndDisplayUrl(key, newValue);
        }
      }
    }
  }

  return chain;
}

async function validateAndDisplayUrl(field: string, url: string): Promise<void> {
  const spinner = ora(`Validating ${field}...`).start();
  const result = await validateUrl(url);
  spinner.stop();

  if (result.valid) {
    console.log(chalk.green(`  ✓ ${field}: Valid`) + chalk.gray(` [${result.statusCode}]`));
  } else {
    console.log(chalk.red(`  ✗ ${field}: Invalid`) + chalk.gray(` [${result.error ?? result.statusCode}]`));
  }

  const formatCheck = getFormatValidation(field, url);
  if (!formatCheck.valid && formatCheck.warning) {
    console.log(chalk.yellow(`    ⚠ ${formatCheck.warning}`));
  }

  if (result.redirectUrl) {
    console.log(chalk.yellow(`    ⚠ Redirects to: ${result.redirectUrl}`));
  }
}

function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`);
}

async function promptOpenUrls(chain: UnifiedChain): Promise<void> {
  const urls: { field: string; url: string }[] = [];

  // Fields to skip (local paths, non-URL fields, legacy fields)
  const skipFields = ["avatarPath", "headerPath", "avatarIpfs", "headerIpfs", "chainId", "shortName", "isTestnet"];

  // Collect all URLs (including avatar/header IPFS URLs)
  for (const [field, value] of Object.entries(chain.textRecords)) {
    if (value && !field.startsWith("_") && !skipFields.includes(field) &&
        isValidUrlFormat(value)) {
      urls.push({ field, url: value });
    }
  }

  if (urls.length === 0) {
    return;
  }

  while (true) {
    const choices = [
      ...urls.map((u) => ({
        name: `${u.field}: ${u.url.length > 50 ? u.url.substring(0, 47) + "..." : u.url}`,
        value: u.url,
      })),
      { name: chalk.cyan("Open all URLs"), value: "__all__" },
      { name: chalk.gray("← Done"), value: "__done__" },
    ];

    const selected = await select({
      message: "Open URL in browser:",
      choices,
      loop: false,
    });

    if (selected === "__done__") {
      break;
    }

    if (selected === "__all__") {
      for (const u of urls) {
        openUrl(u.url);
      }
      console.log(chalk.gray(`  Opened ${urls.length} URLs`));
    } else {
      openUrl(selected);
      console.log(chalk.gray(`  Opened ${selected}`));
    }
  }
}

// ============================================================================
// Review Flow
// ============================================================================

async function reviewChain(
  chain: UnifiedChain,
  approvedChains: ApprovedChain[],
  excludes: ExcludesFile,
  pinataAvailable: boolean,
  drafts: Map<string, Partial<UnifiedChain>>
): Promise<{ action: "approve" | "reject" | "skip"; chain?: ApprovedChain }> {
  // Display chain info
  displayChainSummary(chain);

  // Validate URLs
  const spinner = ora("Validating URLs...").start();
  const validationResults = await validateAllUrls(chain.textRecords);
  spinner.stop();

  displayValidationResults(validationResults);
  displayImageStatus(chain);

  console.log();

  // Option to open URLs in browser
  const wantsOpen = await confirm({
    message: "Open URLs in browser?",
    default: false,
  });

  if (wantsOpen) {
    await promptOpenUrls(chain);
  }

  // Check for label conflicts
  const existingWithLabel = approvedChains.find((c) => c.label === chain.label);
  if (existingWithLabel) {
    console.log(
      chalk.yellow(
        `⚠ Warning: Label "${chain.label}" already exists in approved chains`
      )
    );
  }

  // Edit option
  const wantsEdit = await confirm({
    message: "Edit any fields?",
    default: false,
  });

  if (wantsEdit) {
    chain = await editChainFields(chain);
    saveDraft(drafts, chain);
    console.log(chalk.green("Fields updated and saved to drafts."));
  }

  // Pinata upload option - use avatarPath/headerPath for local files, avatar/header for IPFS URLs
  const avatarPath = getLocalImagePath(chain.textRecords, "avatar");
  const headerPath = getLocalImagePath(chain.textRecords, "header");
  const avatarAlreadyUploaded = !!getIpfsUrl(chain.textRecords, "avatar");
  const headerAlreadyUploaded = !!getIpfsUrl(chain.textRecords, "header");

  // Only consider images that exist locally and haven't been uploaded yet
  const avatarNeedsUpload = avatarPath && existsSync(avatarPath) && !avatarAlreadyUploaded;
  const headerNeedsUpload = headerPath && existsSync(headerPath) && !headerAlreadyUploaded;
  const hasImagesToUpload = avatarNeedsUpload || headerNeedsUpload;

  if (hasImagesToUpload && pinataAvailable) {
    const imagesToUpload = [
      avatarNeedsUpload ? "avatar" : null,
      headerNeedsUpload ? "header" : null,
    ].filter(Boolean).join(", ");

    const uploadToPinata = await confirm({
      message: `Upload ${imagesToUpload} to Pinata IPFS?`,
      default: false,
    });

    if (uploadToPinata) {
      const uploadSpinner = ora("Uploading to Pinata...").start();
      try {
        const uploaded = await uploadChainImages(
          avatarNeedsUpload ? avatarPath : undefined,
          headerNeedsUpload ? headerPath : undefined,
          chain.label
        );
        uploadSpinner.succeed("Images uploaded to IPFS");

        // Set avatar/header to IPFS URLs (the on-chain values)
        if (uploaded.avatar) {
          console.log(chalk.gray(`  Avatar: ${uploaded.avatar}`));
          chain.textRecords.avatar = uploaded.avatar;
        }
        if (uploaded.header) {
          console.log(chalk.gray(`  Header: ${uploaded.header}`));
          chain.textRecords.header = uploaded.header;
        }

        // Save draft with IPFS URLs
        saveDraft(drafts, chain);
      } catch (error) {
        uploadSpinner.fail("Failed to upload images");
        console.log(
          chalk.red(`  Error: ${error instanceof Error ? error.message : error}`)
        );
      }
    }
  } else if (hasImagesToUpload && !pinataAvailable) {
    console.log(
      chalk.yellow("⚠ Pinata not configured. Skipping IPFS upload option.")
    );
  }

  // Check recommended fields (re-check after potential edits)
  // Either a local path exists OR an IPFS URL is set
  const hasAvatar = !!getLocalImagePath(chain.textRecords, "avatar") || !!getIpfsUrl(chain.textRecords, "avatar");
  const hasHeader = !!getLocalImagePath(chain.textRecords, "header") || !!getIpfsUrl(chain.textRecords, "header");
  const missingRecommended = !hasAvatar || !hasHeader;

  if (missingRecommended) {
    console.log();
    if (!hasAvatar) {
      console.log(chalk.yellow("⚠ Missing recommended: avatar"));
    }
    if (!hasHeader) {
      console.log(chalk.yellow("⚠ Missing recommended: header"));
    }
  }

  // Final decision
  console.log();
  const approveLabel = missingRecommended
    ? chalk.green("Approve") + chalk.yellow(" (missing images)")
    : chalk.green("Approve") + " - Add to approved chains";

  const choices = [
    { name: approveLabel, value: "approve" },
    { name: chalk.red("Reject") + " - Add to excludes list", value: "reject" },
    { name: chalk.gray("Skip") + " - Review later", value: "skip" },
  ];

  const decision = await select({
    message: "What would you like to do with this chain?",
    choices,
    loop: false,
  });

  if (decision === "approve") {
    const approvedChain = toApprovedChain(chain);
    return { action: "approve", chain: approvedChain };
  } else if (decision === "reject") {
    return { action: "reject" };
  }

  return { action: "skip" };
}

// ============================================================================
// Main Menu
// ============================================================================

type MainMenuAction =
  | "search"
  | "list-mainnets"
  | "list-testnets"
  | "list-all"
  | "edit-approved"
  | "stats"
  | "exit";

async function promptMainMenu(): Promise<MainMenuAction> {
  return await select({
    message: "What would you like to do?",
    choices: [
      { name: "🔍 Search for a chain", value: "search" },
      { name: "📋 List pending mainnets", value: "list-mainnets" },
      { name: "🧪 List pending testnets", value: "list-testnets" },
      { name: "✏️  Edit approved chain", value: "edit-approved" },
      { name: "📊 Show statistics", value: "stats" },
      { name: "🚪 Exit", value: "exit" },
    ],
    loop: false,
  });
}

async function selectChainFromList(
  chains: UnifiedChain[],
  title: string
): Promise<UnifiedChain | null> {
  if (chains.length === 0) {
    console.log(chalk.yellow("No chains found."));
    return null;
  }

  const pageSize = 15;
  const choices = chains.slice(0, 50).map((chain) => ({
    name: `${chain.name} ${chalk.gray(`(${chain.label}, ${chain.caip2})`)}${chain.isTestnet ? chalk.yellow(" [testnet]") : ""}`,
    value: chain.caip2,
  }));

  if (chains.length > 50) {
    console.log(
      chalk.yellow(
        `Showing first 50 of ${chains.length} chains. Use search to narrow results.`
      )
    );
  }

  choices.push({ name: chalk.gray("← Back to menu"), value: "__back__" });

  const selected = await select({
    message: title,
    choices,
    pageSize,
    loop: false,
  });

  if (selected === "__back__") {
    return null;
  }

  return chains.find((c) => c.caip2 === selected) ?? null;
}

function searchApprovedChains(chains: ApprovedChain[], query: string): ApprovedChain[] {
  const lowerQuery = query.toLowerCase();
  return chains.filter((chain) => {
    return (
      chain.label.toLowerCase().includes(lowerQuery) ||
      chain.chainName.toLowerCase().includes(lowerQuery) ||
      chain.aliases.some((alias) => alias.toLowerCase().includes(lowerQuery)) ||
      chain.textRecords.chainId?.toLowerCase().includes(lowerQuery)
    );
  });
}

async function selectApprovedChainFromList(
  chains: ApprovedChain[],
  title: string
): Promise<ApprovedChain | null> {
  if (chains.length === 0) {
    console.log(chalk.yellow("No approved chains found."));
    return null;
  }

  const pageSize = 15;
  const choices = chains.slice(0, 50).map((chain) => ({
    name: `${chain.chainName} ${chalk.gray(`(${chain.label})`)}`,
    value: chain.label,
  }));

  if (chains.length > 50) {
    console.log(
      chalk.yellow(
        `Showing first 50 of ${chains.length} chains. Use search to narrow results.`
      )
    );
  }

  choices.push({ name: chalk.gray("← Back to menu"), value: "__back__" });

  const selected = await select({
    message: title,
    choices,
    pageSize,
    loop: false,
  });

  if (selected === "__back__") {
    return null;
  }

  return chains.find((c) => c.label === selected) ?? null;
}

function approvedChainToUnified(chain: ApprovedChain): UnifiedChain {
  const chainId = chain.textRecords.chainId ?? "";
  const parts = chainId.includes(":") ? chainId.split(":") : ["eip155", chainId];

  return {
    namespace: parts[0] as "eip155",
    reference: parts[1] ?? "",
    caip2: chainId,
    label: chain.label,
    name: chain.chainName,
    aliases: chain.aliases,
    interoperableAddress: chain.interoperableAddressHex,
    isTestnet: chain.textRecords.isTestnet === "true",
    textRecords: { ...chain.textRecords } as Record<string, string>,
    _sources: ["approved"],
  };
}

async function editApprovedChain(
  chain: ApprovedChain,
  approvedChains: ApprovedChain[],
  pinataAvailable: boolean,
  drafts: Map<string, Partial<UnifiedChain>>
): Promise<ApprovedChain | null> {
  // Convert to unified format for editing
  let unified = approvedChainToUnified(chain);

  // Display chain info
  displayChainSummary(unified);

  // Validate URLs
  const spinner = ora("Validating URLs...").start();
  const validationResults = await validateAllUrls(unified.textRecords);
  spinner.stop();

  displayValidationResults(validationResults);
  displayImageStatus(unified);

  console.log();

  // Option to open URLs in browser
  const wantsOpen = await confirm({
    message: "Open URLs in browser?",
    default: false,
  });

  if (wantsOpen) {
    await promptOpenUrls(unified);
  }

  // Edit option
  const wantsEdit = await confirm({
    message: "Edit any fields?",
    default: true,
  });

  if (wantsEdit) {
    unified = await editChainFields(unified);
    console.log(chalk.green("Fields updated."));
  }

  // Pinata upload option - use avatarPath/headerPath for local files, avatar/header for IPFS URLs
  const avatarPath = getLocalImagePath(unified.textRecords, "avatar");
  const headerPath = getLocalImagePath(unified.textRecords, "header");
  const avatarAlreadyUploaded = !!getIpfsUrl(unified.textRecords, "avatar");
  const headerAlreadyUploaded = !!getIpfsUrl(unified.textRecords, "header");

  const avatarNeedsUpload = avatarPath && existsSync(avatarPath) && !avatarAlreadyUploaded;
  const headerNeedsUpload = headerPath && existsSync(headerPath) && !headerAlreadyUploaded;
  const hasImagesToUpload = avatarNeedsUpload || headerNeedsUpload;

  if (hasImagesToUpload && pinataAvailable) {
    const imagesToUpload = [
      avatarNeedsUpload ? "avatar" : null,
      headerNeedsUpload ? "header" : null,
    ].filter(Boolean).join(", ");

    const uploadToPinata = await confirm({
      message: `Upload ${imagesToUpload} to Pinata IPFS?`,
      default: true,
    });

    if (uploadToPinata) {
      const uploadSpinner = ora("Uploading to Pinata...").start();
      try {
        const uploaded = await uploadChainImages(
          avatarNeedsUpload ? avatarPath : undefined,
          headerNeedsUpload ? headerPath : undefined,
          unified.label
        );
        uploadSpinner.succeed("Images uploaded to IPFS");

        // Set avatar/header to IPFS URLs (the on-chain values)
        if (uploaded.avatar) {
          console.log(chalk.gray(`  Avatar: ${uploaded.avatar}`));
          unified.textRecords.avatar = uploaded.avatar;
        }
        if (uploaded.header) {
          console.log(chalk.gray(`  Header: ${uploaded.header}`));
          unified.textRecords.header = uploaded.header;
        }
      } catch (error) {
        uploadSpinner.fail("Failed to upload images");
        console.log(
          chalk.red(`  Error: ${error instanceof Error ? error.message : error}`)
        );
      }
    }
  }

  // Final decision
  console.log();
  const decision = await select({
    message: "Save changes?",
    choices: [
      { name: chalk.green("Save") + " - Update approved chain", value: "save" },
      { name: chalk.gray("Cancel") + " - Discard changes", value: "cancel" },
    ],
    loop: false,
  });

  if (decision === "save") {
    // Copy textRecords and remove internal path fields (not for on-chain storage)
    const { avatarPath, headerPath, ...cleanTextRecords } = unified.textRecords;

    // Convert back to ApprovedChain format
    return {
      label: unified.label,
      chainName: unified.name,
      interoperableAddressHex: unified.interoperableAddress,
      aliases: unified.aliases,
      textRecords: {
        chainId: unified.caip2,
        ...cleanTextRecords,
      },
      _approvedAt: chain._approvedAt,
      _approvedFrom: chain._approvedFrom,
    };
  }

  return null;
}

function showStats(
  rawChains: UnifiedChain[],
  approvedChains: ApprovedChain[],
  excludes: ExcludesFile,
  pendingChains: UnifiedChain[]
): void {
  console.log();
  console.log(chalk.bold.cyan("═".repeat(40)));
  console.log(chalk.bold.cyan("  Statistics"));
  console.log(chalk.bold.cyan("═".repeat(40)));
  console.log();

  console.log(`  ${chalk.white("Raw chains:")}      ${rawChains.length}`);
  console.log(`  ${chalk.green("Approved:")}        ${approvedChains.length}`);
  console.log(`  ${chalk.red("Excluded:")}        ${excludes.chains.length}`);
  console.log(`  ${chalk.yellow("Pending:")}         ${pendingChains.length}`);
  console.log();

  const pendingMainnets = pendingChains.filter((c) => !c.isTestnet);
  const pendingTestnets = pendingChains.filter((c) => c.isTestnet);

  console.log(
    `  ${chalk.white("Pending mainnets:")} ${pendingMainnets.length}`
  );
  console.log(
    `  ${chalk.white("Pending testnets:")} ${pendingTestnets.length}`
  );
  console.log();
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log();
  console.log(chalk.bold.cyan("═".repeat(50)));
  console.log(chalk.bold.cyan("  Chain Approval Tool"));
  console.log(chalk.bold.cyan("═".repeat(50)));
  console.log();

  // Load data
  const rawChains = loadRawChains();
  let approvedChains = loadApprovedChains();
  let excludes = loadExcludes();
  const drafts = loadDrafts();

  // Create sets for quick lookup
  const approvedCaip2s = new Set(
    approvedChains.map((c) => c._approvedFrom ?? c.textRecords.chainId)
  );
  const excludedCaip2s = new Set(excludes.chains);

  // Filter to pending chains and apply any saved drafts
  let pendingChains = rawChains
    .filter((c) => !approvedCaip2s.has(c.caip2) && !excludedCaip2s.has(c.caip2))
    .map((c) => {
      const draft = drafts.get(c.caip2);
      return draft ? applyDraft(c, draft) : c;
    });

  console.log(chalk.gray(`Loaded ${rawChains.length} raw chains`));
  console.log(chalk.green(`${approvedChains.length} already approved`));
  console.log(chalk.red(`${excludes.chains.length} excluded`));
  console.log(chalk.yellow(`${pendingChains.length} pending review`));
  if (drafts.size > 0) {
    console.log(chalk.cyan(`${drafts.size} with saved edits`));
  }
  console.log();

  // Check Pinata configuration
  let pinataAvailable = false;
  if (isPinataConfigured()) {
    const spinner = ora("Testing Pinata connection...").start();
    pinataAvailable = await testPinataConnection();
    if (pinataAvailable) {
      spinner.succeed("Pinata connection verified");
    } else {
      spinner.warn("Pinata configured but connection failed");
    }
  } else {
    console.log(chalk.gray("Pinata not configured (PINATA_JWT not set)"));
  }

  console.log();

  // Main loop
  while (true) {
    const action = await promptMainMenu();

    if (action === "exit") {
      console.log(chalk.gray("\nGoodbye!"));
      break;
    }

    if (action === "stats") {
      showStats(rawChains, approvedChains, excludes, pendingChains);
      continue;
    }

    let selectedChain: UnifiedChain | null = null;

    if (action === "search") {
      const query = await input({
        message: "Search query (name, label, chain ID):",
      });

      if (query.trim() === "") {
        continue;
      }

      const matches = searchChains(pendingChains, query.trim());
      console.log(chalk.gray(`Found ${matches.length} matching chains`));

      if (matches.length === 0) {
        // Also search in already-approved chains
        const approvedMatches = searchChains(
          rawChains.filter((c) => approvedCaip2s.has(c.caip2)),
          query.trim()
        );
        if (approvedMatches.length > 0) {
          console.log(
            chalk.yellow(
              `Note: ${approvedMatches.length} matches found in already-approved chains`
            )
          );
        }
        continue;
      }

      selectedChain = await selectChainFromList(matches, "Select a chain:");
    } else if (action === "list-mainnets") {
      const mainnets = pendingChains.filter((c) => !c.isTestnet);
      selectedChain = await selectChainFromList(
        mainnets,
        "Select a mainnet chain:"
      );
    } else if (action === "list-testnets") {
      const testnets = pendingChains.filter((c) => c.isTestnet);
      selectedChain = await selectChainFromList(
        testnets,
        "Select a testnet chain:"
      );
    } else if (action === "edit-approved") {
      // Search or list approved chains
      const query = await input({
        message: "Search approved chains (or press Enter to list all):",
      });

      let matches: ApprovedChain[];
      if (query.trim() === "") {
        matches = approvedChains;
      } else {
        matches = searchApprovedChains(approvedChains, query.trim());
        console.log(chalk.gray(`Found ${matches.length} matching approved chains`));
      }

      if (matches.length === 0) {
        console.log(chalk.yellow("No matching approved chains found."));
        continue;
      }

      const selectedApproved = await selectApprovedChainFromList(
        matches,
        "Select an approved chain to edit:"
      );

      if (!selectedApproved) {
        continue;
      }

      const updatedChain = await editApprovedChain(
        selectedApproved,
        approvedChains,
        pinataAvailable,
        drafts
      );

      if (updatedChain) {
        // Replace the chain in the approved list
        const index = approvedChains.findIndex(
          (c) => c.label === selectedApproved.label
        );
        if (index !== -1) {
          approvedChains[index] = updatedChain;
          saveApprovedChains(approvedChains);
          console.log(chalk.green(`✓ Chain "${updatedChain.label}" updated!`));
        }
      } else {
        console.log(chalk.gray("Changes discarded."));
      }

      console.log();
      continue;
    }

    if (!selectedChain) {
      continue;
    }

    // Review the selected chain
    const result = await reviewChain(
      selectedChain,
      approvedChains,
      excludes,
      pinataAvailable,
      drafts
    );

    if (result.action === "approve" && result.chain) {
      approvedChains.push(result.chain);
      saveApprovedChains(approvedChains);
      removeDraft(drafts, selectedChain.caip2);
      console.log(chalk.green(`✓ Chain "${result.chain.label}" approved!`));

      // Update pending chains
      pendingChains = pendingChains.filter(
        (c) => c.caip2 !== selectedChain!.caip2
      );
    } else if (result.action === "reject") {
      excludes.chains.push(selectedChain.caip2);
      saveExcludes(excludes);
      removeDraft(drafts, selectedChain.caip2);
      console.log(chalk.red(`✗ Chain "${selectedChain.label}" rejected!`));

      // Update pending chains
      pendingChains = pendingChains.filter(
        (c) => c.caip2 !== selectedChain!.caip2
      );
    } else {
      console.log(chalk.gray(`Chain "${selectedChain.label}" skipped.`));
    }

    console.log();
  }
}

main().catch((err) => {
  console.error(chalk.red("Fatal error:"), err);
  process.exit(1);
});
