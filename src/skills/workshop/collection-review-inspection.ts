import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists, root, walkDirectory } from "../../infra/fs-safe.js";
import { scanSkillContent, scanSource } from "../security/scanner.js";
import { restoreSkillCollectionDirectoryFromBackup } from "./collection-rollback.js";
import { isUtf8Buffer, MAX_EVALUATION_FILE_BYTES } from "./proposal-bundle.js";

const MAX_WORKSHOP_REVIEW_ENTRIES = 10_000;

export type WorkshopReviewSkillFile = {
  relativeDir: string;
  relativePath: string;
  filePath: string;
  contentHash: string;
};

export async function inspectWorkshopReviewTree(params: {
  skillsRoot: string;
  backupDir: string;
  beforeFiles: ReadonlyMap<string, WorkshopReviewSkillFile>;
  beforeLoadedDirs: ReadonlySet<string>;
  resolveAfterLoadedDirs: () => Promise<ReadonlySet<string>>;
  assertCurrent: () => void;
}): Promise<{
  afterFiles: Map<string, WorkshopReviewSkillFile>;
  reviewErrors: string[];
}> {
  let afterFiles: Map<string, WorkshopReviewSkillFile>;
  try {
    afterFiles = await snapshotWorkshopSkillFiles(params.skillsRoot);
  } catch (error) {
    await restoreWorkshopReviewTreeFromBackup({
      skillsRoot: params.skillsRoot,
      backupDir: params.backupDir,
    });
    throw error;
  }
  const afterLoadedDirs = await params.resolveAfterLoadedDirs();
  const beforeFileDirs = new Set([...params.beforeFiles.values()].map((file) => file.relativeDir));
  const revertedDirs = new Set<string>();
  const reviewErrors: string[] = [];
  const changedFiles = [...afterFiles.values()].filter((file) => {
    const previous = params.beforeFiles.get(file.relativePath);
    return !previous || previous.contentHash !== file.contentHash;
  });
  const criticalFilesByDir = new Map<string, string>();
  const skillsRootAccess = await root(params.skillsRoot);
  for (const file of changedFiles) {
    params.assertCurrent();
    let findings;
    try {
      findings = await scanWorkshopReviewFile(file, skillsRootAccess);
    } catch (error) {
      await restoreWorkshopReviewTreeFromBackup({
        skillsRoot: params.skillsRoot,
        backupDir: params.backupDir,
      });
      throw error;
    }
    if (findings.some((finding) => finding.severity === "critical")) {
      if (!criticalFilesByDir.has(file.relativeDir)) {
        criticalFilesByDir.set(file.relativeDir, file.relativePath);
      }
    }
  }
  for (const [relativeDir, relativePath] of criticalFilesByDir) {
    params.assertCurrent();
    await restoreWorkshopReviewPath({
      skillsRoot: params.skillsRoot,
      backupDir: params.backupDir,
      relativeDir,
      relativePath,
      existedBefore:
        relativeDir === "."
          ? params.beforeFiles.has(relativePath)
          : beforeFileDirs.has(relativeDir),
    });
    revertedDirs.add(relativeDir);
    reviewErrors.push(`security scan rejected ${relativePath}`);
  }
  for (const file of afterFiles.values()) {
    if (
      afterLoadedDirs.has(file.relativeDir) ||
      revertedDirs.has(file.relativeDir) ||
      (!params.beforeLoadedDirs.has(file.relativeDir) && !beforeFileDirs.has(file.relativeDir))
    ) {
      continue;
    }
    params.assertCurrent();
    await restoreWorkshopReviewPath({
      skillsRoot: params.skillsRoot,
      backupDir: params.backupDir,
      relativeDir: file.relativeDir,
      relativePath: file.relativePath,
      existedBefore:
        file.relativeDir === "."
          ? params.beforeFiles.has(file.relativePath)
          : beforeFileDirs.has(file.relativeDir),
    });
    revertedDirs.add(file.relativeDir);
    reviewErrors.push(`review left ${file.relativeDir} unloadable`);
  }
  return { afterFiles, reviewErrors };
}

export async function snapshotWorkshopSkillFiles(
  skillsRoot: string,
): Promise<Map<string, WorkshopReviewSkillFile>> {
  const walked = await walkDirectory(skillsRoot, {
    // Bound each snapshot to 10,000 entries and six levels so a review cannot exhaust memory.
    maxDepth: 6,
    maxEntries: MAX_WORKSHOP_REVIEW_ENTRIES,
    symlinks: "skip",
    include: (entry) => entry.kind === "file",
    descend: (entry) => !entry.name.startsWith(".") && entry.name !== "node_modules",
  });
  if (walked.truncated || walked.failedDirs?.length) {
    throw new Error(
      walked.truncated
        ? "Skill collection review inventory exceeds 10,000 files or six directory levels. Split or prune the Workshop directory by hand, then run the review again."
        : "Could not fully inspect the Skill Workshop directory.",
    );
  }
  const skillsRootAccess = await root(skillsRoot);
  const skillDirs = new Set(
    walked.entries
      .filter((entry) => entry.kind === "file" && entry.name === "SKILL.md")
      .map((entry) => path.dirname(entry.relativePath)),
  );
  const snapshots = await Promise.all(
    walked.entries
      .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map(async (entry) => {
        const read = await skillsRootAccess.read(entry.relativePath, {
          hardlinks: "reject",
          maxBytes: MAX_EVALUATION_FILE_BYTES,
          symlinks: "reject",
        });
        return {
          relativeDir: resolveWorkshopSkillDirectory(entry.relativePath, skillDirs),
          relativePath: entry.relativePath,
          filePath: entry.path,
          contentHash: sha256Hex(read.buffer),
        } satisfies WorkshopReviewSkillFile;
      }),
  );
  return new Map(snapshots.map((snapshot) => [snapshot.relativePath, snapshot]));
}

async function restoreWorkshopReviewTreeFromBackup(params: {
  skillsRoot: string;
  backupDir: string;
}): Promise<void> {
  await fs.rm(params.skillsRoot, { recursive: true, force: true });
  await fs.cp(path.join(params.backupDir, "skills"), params.skillsRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
}

function resolveWorkshopSkillDirectory(
  relativePath: string,
  skillDirs: ReadonlySet<string>,
): string {
  const ownDirectory = path.dirname(relativePath);
  let directory = ownDirectory;
  while (directory !== ".") {
    if (skillDirs.has(directory)) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return skillDirs.has(".") ? "." : ownDirectory;
}

async function scanWorkshopReviewFile(
  file: WorkshopReviewSkillFile,
  skillsRootAccess: Awaited<ReturnType<typeof root>>,
) {
  const read = await skillsRootAccess.read(file.relativePath, {
    hardlinks: "reject",
    maxBytes: MAX_EVALUATION_FILE_BYTES,
    symlinks: "reject",
  });
  if (!isUtf8Buffer(read.buffer)) {
    return [];
  }
  const content = read.buffer.toString("utf8");
  return [...scanSkillContent(content, file.filePath), ...scanSource(content, file.filePath)];
}

async function restoreWorkshopReviewPath(params: {
  skillsRoot: string;
  backupDir: string;
  relativeDir: string;
  relativePath: string;
  existedBefore: boolean;
}): Promise<void> {
  if (params.relativeDir !== ".") {
    await restoreSkillCollectionDirectoryFromBackup({
      skillsRoot: params.skillsRoot,
      backupDir: params.backupDir,
      relativeDir: params.relativeDir,
      existedBefore: params.existedBefore,
    });
    return;
  }
  // Root-level files are not skills, but critical stray files still need per-file reversion.
  const livePath = path.join(params.skillsRoot, params.relativePath);
  if (await pathExists(livePath)) {
    await removePathWithinRoot({
      rootDir: params.skillsRoot,
      relativePath: params.relativePath,
      recursive: false,
      force: true,
    });
  }
  if (params.existedBefore) {
    await fs.cp(path.join(params.backupDir, "skills", params.relativePath), livePath, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  }
}
