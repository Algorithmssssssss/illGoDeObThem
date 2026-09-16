import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
  APK,
  AndroidJob,
  ApkFileTreeNode,
  ClassSource,
  DexClass,
  ManifestInfo,
  androidJobSocketUrl,
  apkFileDownloadUrl,
  deleteApk,
  getAndroidJob,
  getApkFilePreview,
  getApkTree,
  getClassSource,
  getDexClasses,
  getManifest,
  listApkJobs,
  requestDecompile,
  uploadApk,
} from "../androidApi";
import { FilePreview } from "../api";
import UploadForm from "./UploadForm";
import FileTree, { androidIconFor } from "./FileTree";
import PlistViewer from "./PlistViewer";
import FileViewer from "./FileViewer";
import DexClassBrowser from "./DexClassBrowser";
import DexClassDetailView from "./DexClassDetailView";

type WorkspaceTab = "files" | "manifest" | "classes";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AndroidWorkbenchPage({
  apks,
  selectedApkId,
  onSelectApk,
  onApksChanged,
}: {
  apks: APK[];
  selectedApkId: string | null;
  onSelectApk: (id: string | null) => void;
  onApksChanged: () => void;
}) {
  const selectedApk = apks.find((a) => a.id === selectedApkId) ?? null;
  const [job, setJob] = useState<AndroidJob | null>(null);
  const [tree, setTree] = useState<ApkFileTreeNode[]>([]);
  const [manifest, setManifest] = useState<ManifestInfo | null>(null);
  const [selectedNode, setSelectedNode] = useState<ApkFileTreeNode | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("files");
  const [classes, setClasses] = useState<DexClass[]>([]);
  const [classWarnings, setClassWarnings] = useState<string[]>([]);
  const [selectedClass, setSelectedClass] = useState<DexClass | null>(null);
  const [classSource, setClassSource] = useState<ClassSource | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceProgress, setSourceProgress] = useState<AndroidJob | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sourceWsRef = useRef<WebSocket | null>(null);

  const loadResults = useCallback((apkId: string) => {
    getApkTree(apkId).then(setTree).catch(console.error);
    getManifest(apkId).then(setManifest).catch(console.error);
    getDexClasses(apkId)
      .then((r) => {
        setClasses(r.classes);
        setClassWarnings(r.warnings);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!selectedApkId) return;
    setTree([]);
    setManifest(null);
    setSelectedNode(null);
    setFilePreview(null);
    setClasses([]);
    setClassWarnings([]);
    setSelectedClass(null);
    setClassSource(null);
    setSourceError(null);
    sourceWsRef.current?.close();
    setTab("files");

    let cancelled = false;

    async function init() {
      const apk = apks.find((a) => a.id === selectedApkId) ?? null;

      if (apk?.status === "ready") {
        loadResults(selectedApkId!);
        return;
      }

      const jobs = await listApkJobs(selectedApkId!);
      const latest = jobs[jobs.length - 1];
      if (!latest || cancelled) return;
      setJob(latest);

      if (latest.status === "done") {
        loadResults(selectedApkId!);
        return;
      }

      const ws = new WebSocket(androidJobSocketUrl(latest.id));
      wsRef.current = ws;
      ws.onmessage = (evt) => {
        const payload = JSON.parse(evt.data);
        setJob((prev) => (prev ? { ...prev, ...payload } : prev));
        if (payload.status === "done") {
          loadResults(selectedApkId!);
          onApksChanged();
          ws.close();
        } else if (payload.status === "failed") {
          onApksChanged();
          ws.close();
        }
      };
      ws.onerror = () => {
        const poll = setInterval(async () => {
          const j = await getAndroidJob(latest.id);
          setJob(j);
          if (j.status === "done" || j.status === "failed") {
            clearInterval(poll);
            loadResults(selectedApkId!);
            onApksChanged();
          }
        }, 2000);
      };
    }

    init();

    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedApkId]);

  useEffect(() => {
    setFilePreview(null);
    setPreviewError(null);
    if (!selectedApkId || !selectedNode || selectedNode.kind !== "file") {
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    getApkFilePreview(selectedApkId, selectedNode.path)
      .then((preview) => {
        if (!cancelled) setFilePreview(preview);
      })
      .catch((e) => {
        if (!cancelled) setPreviewError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedApkId, selectedNode]);

  useEffect(() => {
    sourceWsRef.current?.close();
    setClassSource(null);
    setSourceError(null);
    setSourceProgress(null);
    if (!selectedApkId || !selectedClass) return;

    let cancelled = false;
    setSourceLoading(true);

    async function run() {
      try {
        const resp = await requestDecompile(selectedApkId!, selectedClass!.name);
        if (cancelled) return;

        if (resp.cached && resp.result) {
          setClassSource(resp.result);
          setSourceLoading(false);
          return;
        }

        if (!resp.job_id) {
          setSourceError("Decompile request did not return a job.");
          setSourceLoading(false);
          return;
        }

        const finish = async () => {
          try {
            const result = await getClassSource(selectedApkId!, selectedClass!.name);
            if (!cancelled) setClassSource(result);
          } catch (e) {
            if (!cancelled) setSourceError((e as Error).message);
          } finally {
            if (!cancelled) setSourceLoading(false);
          }
        };

        const ws = new WebSocket(androidJobSocketUrl(resp.job_id));
        sourceWsRef.current = ws;
        ws.onmessage = (evt) => {
          const payload = JSON.parse(evt.data);
          setSourceProgress((prev) => (prev ? { ...prev, ...payload } : payload));
          if (payload.status === "done") {
            ws.close();
            finish();
          } else if (payload.status === "failed") {
            ws.close();
            if (!cancelled) {
              setSourceError(payload.message || "Decompile failed.");
              setSourceLoading(false);
            }
          }
        };
        ws.onerror = () => {
          const poll = setInterval(async () => {
            const j = await getAndroidJob(resp.job_id!);
            setSourceProgress(j);
            if (j.status === "done") {
              clearInterval(poll);
              finish();
            } else if (j.status === "failed") {
              clearInterval(poll);
              if (!cancelled) {
                setSourceError(j.error_message || "Decompile failed.");
                setSourceLoading(false);
              }
            }
          }, 1500);
        };
      } catch (e) {
        if (!cancelled) {
          setSourceError((e as Error).message);
          setSourceLoading(false);
        }
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [selectedApkId, selectedClass]);

  async function handleDeleteApk(apk: APK, e: MouseEvent) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${apk.original_filename}" and all of its analysis data? This can't be undone.`)) {
      return;
    }
    try {
      await deleteApk(apk.id);
      if (selectedApkId === apk.id) {
        onSelectApk(null);
      }
      onApksChanged();
    } catch (e) {
      window.alert(`Failed to delete: ${(e as Error).message}`);
    }
  }

  return (
    <>
      <aside className="scan-sidebar">
        <UploadForm
          accept=".apk"
          label="Drop an .apk"
          uploadFn={uploadApk}
          onUploaded={(apk) => {
            onApksChanged();
            onSelectApk(apk.id);
          }}
        />
        <div className="scan-list-label">Scans</div>
        <div className="ipa-list">
          {apks.map((apk) => (
            <div
              key={apk.id}
              className={`ipa-row ${selectedApkId === apk.id ? "selected" : ""}`}
              onClick={() => onSelectApk(apk.id)}
            >
              <div className="ipa-row-main">
                <div className="ipa-name" title={apk.original_filename}>
                  {apk.app_name || apk.package_name || apk.original_filename}
                </div>
                <div className="ipa-sub">{formatSize(apk.size_bytes)}</div>
              </div>
              <span className={`pill pill-${apk.status}`}>{apk.status}</span>
              <button
                className="ipa-delete-btn"
                title="Delete this scan"
                onClick={(e) => handleDeleteApk(apk, e)}
              >
                🗑
              </button>
            </div>
          ))}
          {apks.length === 0 && <div className="empty-hint small">No scans yet.</div>}
        </div>
      </aside>

      <div className="content">
        {!selectedApkId && (
          <div className="empty-state">
            <div className="empty-state-icon">🤖</div>
            <div>Upload an .apk to get started.</div>
          </div>
        )}

        {selectedApkId && selectedApk?.status !== "ready" && (
          <div className="job-status">
            <div className="job-status-label">
              Status: <span className={`pill pill-${selectedApk?.status ?? job?.status}`}>{selectedApk?.status ?? job?.status}</span>
            </div>
            {job && (
              <>
                <div className="progress-bar-outer">
                  <div className="progress-bar-inner" style={{ width: `${job.progress_pct}%` }} />
                </div>
                <div className="job-message">{job.message}</div>
                {job.error_message && <div className="error-text">{job.error_message}</div>}
              </>
            )}
          </div>
        )}

        {selectedApkId && selectedApk?.status === "ready" && (
          <>
            <div className="workbench-toolbar">
              <div className="tab-bar">
                <button className={`tab-btn ${tab === "files" ? "active" : ""}`} onClick={() => setTab("files")}>
                  Files
                </button>
                <button className={`tab-btn ${tab === "manifest" ? "active" : ""}`} onClick={() => setTab("manifest")}>
                  Manifest
                </button>
                <button className={`tab-btn ${tab === "classes" ? "active" : ""}`} onClick={() => setTab("classes")}>
                  Classes {classes.length > 0 && <span className="tab-count">{classes.length}</span>}
                </button>
              </div>
            </div>

            {tab === "files" && (
              <div className="workspace">
                <div className="panel tree-panel">
                  <div className="panel-heading">APK contents</div>
                  <FileTree nodes={tree} onSelect={setSelectedNode} selectedPath={selectedNode?.path ?? null} getIcon={androidIconFor} />
                </div>
                <div className="panel detail-panel">
                  {!selectedNode && (
                    <div className="empty-state">
                      <div className="empty-state-icon">📄</div>
                      <div>Select a file in the tree to inspect it.</div>
                    </div>
                  )}

                  {selectedNode && selectedNode.kind === "dir" && (
                    <div className="file-detail">
                      <h3>{selectedNode.name}</h3>
                      <div className="muted">Directory · {selectedNode.children.length} item(s)</div>
                    </div>
                  )}

                  {selectedNode && selectedNode.kind === "file" && (
                    <>
                      {previewLoading && <div className="empty-hint">Loading…</div>}
                      {previewError && <div className="error-text">{previewError}</div>}
                      {filePreview && (
                        <FileViewer
                          title={selectedNode.name}
                          preview={filePreview}
                          downloadUrl={apkFileDownloadUrl(selectedApkId, selectedNode.path)}
                        />
                      )}
                      {selectedNode.is_main_binary && (
                        <div className="badge badge-clickable" onClick={() => setTab("classes")}>
                          DEX bytecode — browse its classes →
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {tab === "manifest" && (
              <div className="workspace">
                <div className="panel detail-panel" style={{ gridColumn: "1 / -1" }}>
                  {manifest?.warnings && manifest.warnings.length > 0 && (
                    <div className="notice">{manifest.warnings.join(" ")}</div>
                  )}
                  {manifest ? (
                    <PlistViewer title="AndroidManifest.xml" data={manifest.parsed} />
                  ) : (
                    <div className="empty-hint">Loading…</div>
                  )}
                </div>
              </div>
            )}

            {tab === "classes" && (
              <div className="workspace">
                <div className="panel tree-panel">
                  <DexClassBrowser classes={classes} selected={selectedClass?.name ?? null} onSelect={setSelectedClass} />
                </div>
                <div className="panel detail-panel">
                  {classWarnings.length > 0 && (
                    <div className="notice">{classWarnings.join(" ")}</div>
                  )}
                  {selectedClass ? (
                    <DexClassDetailView
                      cls={selectedClass}
                      source={classSource}
                      sourceLoading={sourceLoading}
                      sourceError={sourceError}
                      sourceProgress={sourceProgress}
                    />
                  ) : (
                    <div className="empty-state">
                      <div className="empty-state-icon">{classes.length === 0 ? "🚫" : "☕"}</div>
                      <div>
                        {classes.length === 0
                          ? "No app-defined classes found."
                          : "Select a class to view its members and decompiled source."}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
