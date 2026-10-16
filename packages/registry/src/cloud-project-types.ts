import type {AccountPlan} from './account-types';

/** Decimal bytes: MB = 1,000,000 bytes; GB = 1,000,000,000 bytes. */
export const PROJECT_STORAGE_QUOTAS: Readonly<Record<AccountPlan,number>> = {free:100_000_000,plus:2_000_000_000,pro:10_000_000_000,studio:50_000_000_000};
export const PROJECT_CHUNK_BYTES = 8_000_000;
export const PROJECT_MAX_CHUNKS = 8192;
/** Opaque complete portable project artifact. All nonfinal chunks are exactly 8,000,000 bytes;
 * the final chunk has 1..8,000,000 bytes. The host validates its inner format on open. */
export interface CloudProjectManifest {
  format:'femlab-project/1';
  bytes:number;
  chunks:{bytes:number;sha256:string}[];
}
export interface CloudStorageStatus {
  available:boolean;plan:AccountPlan;limitBytes:number;usedBytes:number;reservedBytes:number;
  /** Temporary upload and awaiting-cleanup bytes, separately bounded for replacements too. */
  pendingBytes:number;overQuota:boolean;maxChunkBytes:number;
}
export interface CloudProject {
  id:string;name:string;revision:string;changeVersion:string;bytes:number;updatedAt:string;deletedAt:string|null;
}
export interface CloudProjectList {projects:CloudProject[];nextCursor:string|null;storage:CloudStorageStatus}
export interface CloudProjectRead {project:CloudProject;manifest:CloudProjectManifest}
export interface CloudProjectUploadRequest {projectId?:string;baseRevision:string|null;name:string;manifest:CloudProjectManifest}
export interface CloudProjectUpload {uploadId:string;projectId:string;expiresAt:string;missingChunks:number[]}
/** Conflict responses contain only the authenticated owner's current metadata, never content. */
export interface CloudProjectConflict {code:string;cause:string;where:string;suggestion:string|null;details?:{project?:CloudProject;missingChunks?:number[]}}
