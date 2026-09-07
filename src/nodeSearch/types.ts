import type { DiffSearchMode, DiffSearchTarget } from '../diffUtils';

export interface SearchRequest {
    directory: string;
    query?: string;
    top_k?: number;
    file_ext?: string;
    include_globs?: string[];
    exclude_globs?: string[];
    search_mode?: DiffSearchMode;
    search_target?: DiffSearchTarget;
    diff_base_ref?: string;
    diff_head_ref?: string;
    branch_ref?: string;
    branch_base_ref?: string;
    first_parent?: boolean;
    recent_commit_limit?: number;
    force?: boolean;
}

export interface Branch {
    ref: string;
    name: string;
    head_hash: string;
    aliases: string[];
    commit_count?: number;
    file_count?: number;
}

export interface DiffUnit {
    path: string;
    file_path: string;
    diff_old_path: string | null;
    diff_new_path: string | null;
    lineno: number;
    end_lineno: number;
    name: string;
    function_name: string;
    result_type: string;
    symbol_kind: string;
    commit_hash: string;
    commit_subject: string;
    commit_message: string;
    diff_base_ref: string;
    diff_head_ref: string;
    diff_compare: string;
    search_text: string;
    diff_code: string;
    changed_code: string;
    code: string;
    raw_code: string;
    additions: number;
    deletions: number;
    added_ranges: number[][];
    removed_ranges: number[][];
    scored_file_path?: string;
    branch_memberships?: Branch[];
    [key: string]: unknown;
}

export interface SearchProgress {
    active: boolean;
    phase: string;
    current: number;
    total: number;
    elapsed?: number;
    eta?: number;
}

export type ReportProgress = (progress: SearchProgress) => void;
export interface EngineOptions {
    cacheDir: string;
    modelName: string;
    revision: string;
    dtype: 'q8' | 'fp32';
    batchSize: number;
    localFilesOnly?: boolean;
}

export const DEFAULT_MODEL = 'Shuu12121/NightOwl-CodeEmbedding';
// Pin tokenizer and weights together so a Hub update cannot reuse stale vectors.
export const DEFAULT_REVISION = 'cfc3c6d172a93c79826db380ce82b6fee377ae1c';
