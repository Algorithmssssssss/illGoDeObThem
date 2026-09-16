import { FileDiff, FileEntry, FileChanged, FilePreview } from "./api";

const API_BASE = "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface APK {
  id: string;
  original_filename: string;
  size_bytes: number;
  status: "pending" | "extracting" | "ready" | "failed" | string;
  error_message?: string | null;
  app_name?: string | null;
  package_name?: string | null;
  version_name?: string | null;
  version_code?: string | null;
  min_sdk_version?: string | null;
  target_sdk_version?: string | null;
  uploaded_at: string;
}

// Same shape as api.ts's FileTreeNode — kept as its own type since it comes
// from a separate endpoint/table, but structurally identical.
export interface ApkFileTreeNode {
  path: string;
  name: string;
  kind: "file" | "dir";
  size_bytes?: number | null;
  mime_guess?: string | null;
  is_main_binary: boolean;
  children: ApkFileTreeNode[];
}

export interface AndroidJob {
  id: string;
  apk_id: string;
  phase: string;
  status: string;
  progress_pct: number;
  message?: string | null;
  error_message?: string | null;
  context_class_name?: string | null;
}

export interface ManifestInfo {
  parsed: {
    package?: string;
    app_name?: string;
    version_name?: string;
    version_code?: number | string;
    min_sdk_version?: number | string;
    target_sdk_version?: number | string;
    is_multidex?: boolean;
    is_signed?: boolean;
    main_activity?: string | null;
    permissions?: string[];
    activities?: string[];
    services?: string[];
    receivers?: string[];
    providers?: string[];
    features?: string[];
    libraries?: string[];
  };
  warnings: string[];
}

export interface DexMethod {
  name: string;
  descriptor?: string | null;
  access_flags?: string | null;
}

export interface DexField {
  name: string;
  descriptor?: string | null;
  access_flags?: string | null;
}

export interface DexClass {
  name: string;
  superclass?: string | null;
  access_flags?: string | null;
  interfaces: string[];
  methods: DexMethod[];
  fields: DexField[];
}

export interface DexClassesResponse {
  classes: DexClass[];
  warnings: string[];
}

export interface ClassSource {
  class_name: string;
  java_code?: string | null;
  java_error?: string | null;
  smali_code?: string | null;
  smali_error?: string | null;
  truncated: boolean;
}

export interface ClassSourceRequestResult {
  cached: boolean;
  result?: ClassSource | null;
  job_id?: string | null;
}

export async function listApks(): Promise<APK[]> {
  return json(await fetch(`${API_BASE}/apks`));
}

export async function getApk(id: string): Promise<APK> {
  return json(await fetch(`${API_BASE}/apks/${id}`));
}

export async function deleteApk(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/apks/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
}

export async function getApkTree(id: string): Promise<ApkFileTreeNode[]> {
  return json(await fetch(`${API_BASE}/apks/${id}/tree`));
}

export async function getManifest(id: string): Promise<ManifestInfo> {
  return json(await fetch(`${API_BASE}/apks/${id}/manifest`));
}

export async function listApkJobs(id: string): Promise<AndroidJob[]> {
  return json(await fetch(`${API_BASE}/apks/${id}/jobs`));
}

export async function getDexClasses(id: string): Promise<DexClassesResponse> {
  return json(await fetch(`${API_BASE}/apks/${id}/classes`));
}

export async function requestDecompile(id: string, className: string): Promise<ClassSourceRequestResult> {
  return json(
    await fetch(`${API_BASE}/apks/${id}/classes/${encodeURIComponent(className)}/decompile`, {
      method: "POST",
    })
  );
}

export async function getClassSource(id: string, className: string): Promise<ClassSource> {
  return json(await fetch(`${API_BASE}/apks/${id}/classes/${encodeURIComponent(className)}/source`));
}

export async function getApkFilePreview(apkId: string, path: string): Promise<FilePreview> {
  return json(await fetch(`${API_BASE}/apks/${apkId}/file?path=${encodeURIComponent(path)}`));
}

export function apkFileDownloadUrl(apkId: string, path: string): string {
  return `${API_BASE}/apks/${apkId}/file/download?path=${encodeURIComponent(path)}`;
}

export async function getAndroidJob(jobId: string): Promise<AndroidJob> {
  return json(await fetch(`${API_BASE}/android-jobs/${jobId}`));
}

export function androidJobSocketUrl(jobId: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws/android-jobs/${jobId}`;
}

export async function uploadApk(file: File, onProgress?: (pct: number) => void): Promise<APK> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/apks/upload`);
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) {
        onProgress(Math.round((evt.loaded / evt.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

export interface ApkCompareScanRef {
  id: string;
  filename: string;
}

export interface DexClassSummary {
  name: string;
  superclass?: string | null;
  method_count: number;
  field_count: number;
}

export interface DexClassChanged {
  name: string;
  a: DexClassSummary;
  b: DexClassSummary;
}

export interface DexClassDiff {
  only_in_a: DexClassSummary[];
  only_in_a_total: number;
  only_in_b: DexClassSummary[];
  only_in_b_total: number;
  changed: DexClassChanged[];
  changed_total: number;
  common_total: number;
}

export interface ApkCompareResult {
  a: ApkCompareScanRef;
  b: ApkCompareScanRef;
  files: FileDiff;
  classes: DexClassDiff;
}

export async function compareApkScans(aId: string, bId: string): Promise<ApkCompareResult> {
  return json(await fetch(`${API_BASE}/compare/apk?a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`));
}

export type { FileDiff, FileEntry, FileChanged, FilePreview };
