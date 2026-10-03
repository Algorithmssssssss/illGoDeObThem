export type ReflutterMode = "traffic" | "snapshot";

export interface ReflutterJob {
  id: string;
  platform: "ios" | "android" | string;
  original_filename: string;
  size_bytes: number;
  mode: ReflutterMode | string;
  proxy_ip?: string | null;
  status: "queued" | "running" | "done" | "failed" | string;
  progress_pct: number;
  message?: string | null;
  error_message?: string | null;
  output_log?: string | null;
  snapshot_hash?: string | null;
  artifact_filename?: string | null;
  has_artifact: boolean;
  created_at: string;
  finished_at?: string | null;
}

export interface DumpFunction {
  name: string;
  offset?: string | null;
}

export interface DumpClass {
  name: string;
  extends?: string | null;
  functions: DumpFunction[];
}

export interface DumpLibrary {
  name: string;
  classes: DumpClass[];
}

export interface DumpStats {
  libraries: number;
  classes: number;
  functions: number;
  lines: number;
  unparsed: number;
}

export interface ParsedDump {
  libraries: DumpLibrary[];
  stats: DumpStats;
  unparsed_sample: string[];
}

export interface DumpDart {
  id: string;
  reflutter_job_id?: string | null;
  original_filename: string;
  size_bytes: number;
  parsed: ParsedDump;
  created_at: string;
}

export interface DumpDartSummary {
  id: string;
  reflutter_job_id?: string | null;
  original_filename: string;
  size_bytes: number;
  stats: DumpStats;
  created_at: string;
}

const API_BASE = "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function uploadWithProgress<T>(
  url: string,
  form: FormData,
  onProgress?: (pct: number) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
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
    xhr.send(form);
  });
}

export async function uploadReflutter(
  file: File,
  mode: ReflutterMode,
  proxyIp: string | null,
  onProgress?: (pct: number) => void
): Promise<ReflutterJob> {
  const form = new FormData();
  form.append("file", file);
  form.append("mode", mode);
  if (proxyIp) form.append("proxy_ip", proxyIp);
  return uploadWithProgress(`${API_BASE}/reflutter/upload`, form, onProgress);
}

export async function listReflutterJobs(): Promise<ReflutterJob[]> {
  return json(await fetch(`${API_BASE}/reflutter/jobs`));
}

export async function getReflutterJob(id: string): Promise<ReflutterJob> {
  return json(await fetch(`${API_BASE}/reflutter/jobs/${id}`));
}

export async function deleteReflutterJob(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/reflutter/jobs/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
}

export function reflutterArtifactUrl(id: string): string {
  return `${API_BASE}/reflutter/jobs/${id}/artifact`;
}

export async function uploadDumpDart(
  file: File,
  reflutterJobId: string | null,
  onProgress?: (pct: number) => void
): Promise<DumpDart> {
  const form = new FormData();
  form.append("file", file);
  if (reflutterJobId) form.append("reflutter_job_id", reflutterJobId);
  return uploadWithProgress(`${API_BASE}/reflutter/dumpdart/upload`, form, onProgress);
}

export async function listDumpDarts(): Promise<DumpDartSummary[]> {
  return json(await fetch(`${API_BASE}/reflutter/dumpdart`));
}

export async function getDumpDart(id: string): Promise<DumpDart> {
  return json(await fetch(`${API_BASE}/reflutter/dumpdart/${id}`));
}

export async function deleteDumpDart(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/reflutter/dumpdart/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
}
