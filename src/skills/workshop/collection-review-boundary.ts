import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunCronAgentTurnParams } from "../../cron/isolated-agent/run-prepare-runtime.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import type { CronExecutionIdentityAdmission } from "../../cron/service/state.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists, root, walkDirectory } from "../../infra/fs-safe.js";
import type { PluginHookSkillArtifact } from "../../plugins/hook-types.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  snapshotCommittedSkillArtifactBestEffort,
} from "../lifecycle/skill-change-hook.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { scanSkillContent, scanSource } from "../security/scanner.js";
import {
  commitCollectionBackup,
  createCollectionBackup,
  discardPendingCollectionBackup,
} from "./collection-backup.js";
import { pruneOlderSkillCollectionBackups } from "./collection-paths.js";
import { buildCollectionReviewPrompt } from "./collection-review-prompt.js";
import {
  recordSkillCollectionReviewHistory,
  recordSkillCollectionReviewStatus,
  type SkillCollectionReviewResult,
} from "./collection-review-state.js";
import { restoreSkillCollectionDirectoryFromBackup } from "./collection-rollback.js";
import { clearSkillUsageForRemovedSkills } from "./curator.js";
import {
  isUtf8Buffer,
  MAX_EVALUATION_FILE_BYTES,
  readSkillProposalTargetTreeSha256,
} from "./proposal-bundle.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { withSkillCollectionLock } from "./target-lock.js";
import { listWritableWorkshopSkillSummaries } from "./workspace-skill-read.js";

type ReviewTurn = (params: {
  job: RunCronAgentTurnParams["job"];
  message: string;
  abortSignal?: AbortSignal;
  onExecutionStarted?: RunCronAgentTurnParams["onExecutionStarted"];
  onExecutionPhase?: RunCronAgentTurnParams["onExecutionPhase"];
  onLaneWait?: RunCronAgentTurnParams["onLaneWait"];
  executionIdentity?: CronExecutionIdentityAdmission;
  executionRoot: NonNullable<RunCronAgentTurnParams["executionRoot"]>;
}) => Promise<RunCronAgentTurnResult>;

type ReviewSkill = ReturnType<typeof listWritableWorkshopSkillSummaries>[number];
type ReviewChange = {
  action: "created" | "updated" | "removed";
  before?: PluginHookSkillArtifact;
  after?: PluginHookSkillArtifact;
};
type ReviewCommit = { result: RunCronAgentTurnResult; changes: ReviewChange[] };
type ReviewSkillFile = {
  relativeDir: string;
  relativePath: string;
  filePath: string;
  contentHash: string;
};

const MAX_WORKSHOP_REVIEW_ENTRIES = 10_000;
const WORKSHOP_REVIEW_INVENTORY_LIMIT_ERROR =
  "Skill collection review inventory exceeds 10,000 files or six directory levels. Split or prune the Workshop directory by hand, then run the review again.";

class WorkshopReviewInventoryLimitError extends Error {
  constructor() {
    super(WORKSHOP_REVIEW_INVENTORY_LIMIT_ERROR);
    this.name = "WorkshopReviewInventoryLimitError";
  }
}

export async function runSkillCollectionReviewForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  job: RunCronAgentTurnParams["job"];
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  onExecutionStarted?: RunCronAgentTurnParams["onExecutionStarted"];
  onExecutionPhase?: RunCronAgentTurnParams["onExecutionPhase"];
  onLaneWait?: RunCronAgentTurnParams["onLaneWait"];
  executionIdentity?: CronExecutionIdentityAdmission;
  runTurn: ReviewTurn;
}): Promise<RunCronAgentTurnResult> {
  if (params.config.skills?.workshop?.autonomous?.mode !== "auto") {
    return { status: "skipped", summary: "skill collection review disabled" };
  }
  const skillsRoot = resolveWorkshopSkillsDir(params.env);
  const stateOptions = params.env ? { env: params.env } : {};
  const assertCurrent = (lease: { assertOwned: () => void }) => {
    lease.assertOwned();
    params.abortSignal?.throwIfAborted();
  };
  try {
    const commit: ReviewCommit = await withSkillCollectionLock(async (lease) => {
      const attemptedAtMs = Date.now();
      assertCurrent(lease);
      recordSkillCollectionReviewStatus({ attemptedAtMs }, stateOptions);
      assertCurrent(lease);
      await fs.mkdir(skillsRoot, { recursive: true });
      const before = await resolveReviewSkills(params.config, params.env);
      const beforeFiles = await snapshotWorkshopSkillFiles(skillsRoot).catch((error: unknown) => {
        assertCurrent(lease);
        recordSkillCollectionReviewStatus({ attemptedAtMs, error }, stateOptions);
        throw error;
      });
      const backup = await createCollectionBackup({
        skillsRoot,
        skillDirs: before.map((skill) => path.relative(skillsRoot, skill.baseDir)),
        env: params.env,
      });
      const shouldDispatch = hasCommittedSkillChangeHooks();
      const beforeArtifacts = new Map<string, PluginHookSkillArtifact | undefined>();
      if (shouldDispatch) {
        for (const skill of before) {
          assertCurrent(lease);
          beforeArtifacts.set(
            skill.name,
            await snapshotCommittedSkillArtifactBestEffort({
              skillDir: skill.baseDir,
              skillKey: skill.name,
              source: "workshop",
            }),
          );
        }
      }
      try {
        assertCurrent(lease);
        const message = buildCollectionReviewPrompt(before, params.env);
        const turnResult = await params.runTurn({
          job: {
            ...params.job,
            payload: { ...params.job.payload, kind: "agentTurn", message },
          },
          message,
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          ...(params.onExecutionStarted ? { onExecutionStarted: params.onExecutionStarted } : {}),
          ...(params.onExecutionPhase ? { onExecutionPhase: params.onExecutionPhase } : {}),
          ...(params.onLaneWait ? { onLaneWait: params.onLaneWait } : {}),
          ...(params.executionIdentity ? { executionIdentity: params.executionIdentity } : {}),
          // File tools are rooted at the Workshop directory. Exec follows the operator's cron
          // exec-approval policy; with the default policy and no approval client it is denied.
          // Reviewed instructions cannot gain host authority the operator has not granted to automations.
          executionRoot: {
            workspaceDir: skillsRoot,
            cwd: skillsRoot,
            sessionRoot: skillsRoot,
            requireWritableSandbox: true,
          },
        });
        assertCurrent(lease);
        let afterFiles: Map<string, ReviewSkillFile>;
        try {
          afterFiles = await snapshotWorkshopSkillFiles(skillsRoot);
        } catch (error) {
          if (error instanceof WorkshopReviewInventoryLimitError) {
            await restoreWorkshopReviewTreeFromBackup({
              skillsRoot,
              backupDir: backup.backupDir,
            });
          }
          throw error;
        }
        if (turnResult.admissionDisposition === "rejected") {
          const error =
            turnResult.error ??
            `Skill collection review turn ended with status: ${turnResult.status}`;
          const unchanged =
            beforeFiles.size === afterFiles.size &&
            [...beforeFiles].every(
              ([relativePath, file]) =>
                afterFiles.get(relativePath)?.contentHash === file.contentHash,
            );
          if (unchanged) {
            recordSkillCollectionReviewStatus({ attemptedAtMs, error }, stateOptions);
            await discardPendingCollectionBackup(backup);
            return {
              result: { ...turnResult, status: "error", error, summary: error },
              changes: [],
            };
          }
        }
        const reviewErrors: string[] = [];
        const dropReasons = parseDropReasons(turnResult.outputText);
        const after = await resolveReviewSkills(params.config, params.env);
        const beforeByName = new Map(before.map((skill) => [skill.name, skill]));
        const afterByDir = new Map(
          after.map((skill) => [path.relative(skillsRoot, skill.baseDir), skill]),
        );
        const beforeLoadedDirs = new Set(
          before.map((skill) => path.relative(skillsRoot, skill.baseDir)),
        );
        const beforeFileDirs = new Set([...beforeFiles.values()].map((file) => file.relativeDir));
        const revertedDirs = new Set<string>();
        const changedFiles = [...afterFiles.values()].filter((file) => {
          const previous = beforeFiles.get(file.relativePath);
          return !previous || previous.contentHash !== file.contentHash;
        });
        const criticalFilesByDir = new Map<string, string>();
        const skillsRootAccess = await root(skillsRoot);
        for (const file of changedFiles) {
          assertCurrent(lease);
          const findings = await scanWorkshopReviewFile(file, skillsRootAccess);
          if (findings.some((finding) => finding.severity === "critical")) {
            if (!criticalFilesByDir.has(file.relativeDir)) {
              criticalFilesByDir.set(file.relativeDir, file.relativePath);
            }
          }
        }
        for (const [relativeDir, relativePath] of criticalFilesByDir) {
          assertCurrent(lease);
          await restoreWorkshopReviewPath({
            skillsRoot,
            backupDir: backup.backupDir,
            relativeDir,
            relativePath,
            existedBefore:
              relativeDir === "." ? beforeFiles.has(relativePath) : beforeFileDirs.has(relativeDir),
          });
          revertedDirs.add(relativeDir);
          reviewErrors.push(`security scan rejected ${relativePath}`);
        }
        for (const file of afterFiles.values()) {
          if (
            afterByDir.has(file.relativeDir) ||
            revertedDirs.has(file.relativeDir) ||
            (!beforeLoadedDirs.has(file.relativeDir) && !beforeFileDirs.has(file.relativeDir))
          ) {
            continue;
          }
          assertCurrent(lease);
          await restoreWorkshopReviewPath({
            skillsRoot,
            backupDir: backup.backupDir,
            relativeDir: file.relativeDir,
            relativePath: file.relativePath,
            existedBefore:
              file.relativeDir === "."
                ? beforeFiles.has(file.relativePath)
                : beforeFileDirs.has(file.relativeDir),
          });
          revertedDirs.add(file.relativeDir);
          reviewErrors.push(`review left ${file.relativeDir} unloadable`);
        }
        assertCurrent(lease);
        const finalSkills = await resolveReviewSkills(params.config, params.env);
        const finalByName = new Map(finalSkills.map((skill) => [skill.name, skill]));
        const result: SkillCollectionReviewResult = {
          backupId: backup.manifest.id,
          kept: before
            .filter((skill) => finalByName.get(skill.name)?.treeHash === skill.treeHash)
            .map((skill) => skill.name),
          written: finalSkills
            .filter((skill) => {
              const previous = beforeByName.get(skill.name);
              return !previous || previous.treeHash !== skill.treeHash;
            })
            .map((skill) => skill.name),
          dropped: before
            .filter((skill) => !finalByName.has(skill.name))
            .map((skill) => ({
              name: skill.name,
              reason: dropReasons.get(skill.name) ?? "no reason given",
            })),
        };
        assertCurrent(lease);
        await commitCollectionBackup(
          skillsRoot,
          backup,
          finalSkills.map((skill) => path.relative(skillsRoot, skill.baseDir)),
        );
        assertCurrent(lease);
        bumpSkillsSnapshotVersion({ reason: "workshop" });
        assertCurrent(lease);
        recordSkillCollectionReviewHistory(Date.now(), result, stateOptions);
        assertCurrent(lease);
        await pruneOlderSkillCollectionBackups(backup.backupRoot, backup.manifest.id);
        assertCurrent(lease);
        clearSkillUsageForRemovedSkills(
          before
            .filter((skill) => !finalByName.has(skill.name))
            .map((skill) => canonicalizePath(skill.filePath)),
          stateOptions,
        );
        assertCurrent(lease);
        const turnError =
          turnResult.status === "ok"
            ? undefined
            : (turnResult.error ??
              `Skill collection review turn ended with status: ${turnResult.status}`);
        const scanError =
          reviewErrors.length > 0
            ? `Skill collection review completed with errors: ${reviewErrors.join("; ")}`
            : undefined;
        if (turnError || scanError) {
          const error = turnError
            ? `Skill collection review failed: ${turnError}${scanError ? `; ${scanError}` : ""}`
            : scanError;
          recordSkillCollectionReviewStatus({ attemptedAtMs, error }, stateOptions);
          return {
            result: { ...turnResult, status: "error", error, summary: error },
            changes: shouldDispatch
              ? await collectReviewChanges({
                  before,
                  beforeArtifacts,
                  finalSkills,
                  assertCurrent: () => assertCurrent(lease),
                })
              : [],
          };
        }
        recordSkillCollectionReviewStatus(
          { attemptedAtMs, succeededAtMs: Date.now() },
          stateOptions,
        );
        return {
          result: turnResult,
          changes: shouldDispatch
            ? await collectReviewChanges({
                before,
                beforeArtifacts,
                finalSkills,
                assertCurrent: () => assertCurrent(lease),
              })
            : [],
        };
      } catch (error) {
        assertCurrent(lease);
        recordSkillCollectionReviewStatus({ attemptedAtMs, error }, stateOptions);
        await discardPendingCollectionBackup(backup);
        throw error;
      }
    }, stateOptions);
    for (const change of commit.changes) {
      await dispatchCommittedSkillChangeBestEffort({
        ...change,
        source: "workshop",
        workspaceDir: skillsRoot,
      });
    }
    return commit.result;
  } catch (error) {
    const summary = `Skill collection review failed: ${String(error)}`;
    return { status: "error", error: summary, summary };
  }
}

async function collectReviewChanges(params: {
  before: readonly (ReviewSkill & { treeHash: string })[];
  beforeArtifacts: ReadonlyMap<string, PluginHookSkillArtifact | undefined>;
  finalSkills: readonly (ReviewSkill & { treeHash: string })[];
  assertCurrent: () => void;
}): Promise<ReviewChange[]> {
  const beforeByName = new Map(params.before.map((skill) => [skill.name, skill]));
  const finalByName = new Map(params.finalSkills.map((skill) => [skill.name, skill]));
  const names = new Set([...beforeByName.keys(), ...finalByName.keys()]);
  const changes: ReviewChange[] = [];
  for (const name of [...names].toSorted()) {
    const before = beforeByName.get(name);
    const after = finalByName.get(name);
    if (before && after && before.treeHash === after.treeHash) {
      continue;
    }
    params.assertCurrent();
    changes.push({
      action: before ? (after ? "updated" : "removed") : "created",
      before: params.beforeArtifacts.get(name),
      after: after
        ? await snapshotCommittedSkillArtifactBestEffort({
            skillDir: after.baseDir,
            skillKey: after.name,
            source: "workshop",
          })
        : undefined,
    });
  }
  return changes;
}

async function resolveReviewSkills(
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): Promise<Array<ReviewSkill & { treeHash: string }>> {
  const skills = listWritableWorkshopSkillSummaries({ config: resolveReviewConfig(config), env });
  const hashes = await Promise.all(
    skills.map(async (skill) => await readSkillProposalTargetTreeSha256(skill.baseDir)),
  );
  const resolvedSkills: Array<ReviewSkill & { treeHash: string }> = [];
  for (const [index, skill] of skills.entries()) {
    const treeHash = hashes[index];
    if (treeHash === undefined) {
      throw new Error(`Could not hash Workshop skill: ${skill.name}`);
    }
    resolvedSkills.push({ ...skill, treeHash });
  }
  return resolvedSkills;
}

async function snapshotWorkshopSkillFiles(
  skillsRoot: string,
): Promise<Map<string, ReviewSkillFile>> {
  const walked = await walkDirectory(skillsRoot, {
    // Bound each snapshot to 10,000 entries and six levels so a review cannot exhaust memory.
    maxDepth: 6,
    maxEntries: MAX_WORKSHOP_REVIEW_ENTRIES,
    symlinks: "skip",
    include: (entry) => entry.kind === "file",
    descend: (entry) => !entry.name.startsWith(".") && entry.name !== "node_modules",
  });
  if (walked.truncated || walked.failedDirs?.length) {
    if (walked.truncated) {
      throw new WorkshopReviewInventoryLimitError();
    }
    throw new Error("Could not fully inspect the Skill Workshop directory.");
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
        } satisfies ReviewSkillFile;
      }),
  );
  return new Map(snapshots.map((snapshot) => [snapshot.relativePath, snapshot]));
}

// Only for a turn that blew past the inventory bound: the tree can no longer be enumerated, so
// unscanned content must not survive. Entries that existed before the turn but were never loaded
// as skills are lost with it; that is the accepted cost of a bounded, fail-closed review.
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
  file: ReviewSkillFile,
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

function resolveReviewConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    skills: {
      ...config.skills,
      limits: {
        ...config.skills?.limits,
        maxCandidatesPerRoot: Number.MAX_SAFE_INTEGER,
        maxSkillsLoadedPerSource: Number.MAX_SAFE_INTEGER,
      },
    },
  };
}

function parseDropReasons(outputText: string | undefined): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const line of outputText?.split(/\r?\n/u) ?? []) {
    const match = /^DROP\s+(\S+)\s*:\s*(.*)$/u.exec(line.trim());
    if (!match?.[1]) {
      continue;
    }
    reasons.set(match[1], truncateUtf16Safe(match[2]?.trim() ?? "", 300));
  }
  return reasons;
}
