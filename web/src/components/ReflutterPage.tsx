import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import UploadForm from "./UploadForm";
import {
  DumpDart,
  DumpDartSummary,
  ParsedDump,
  ReflutterJob,
  ReflutterMode,
  deleteDumpDart,
  deleteReflutterJob,
  getDumpDart,
  listDumpDarts,
  listReflutterJobs,
  reflutterArtifactUrl,
  uploadDumpDart,
  uploadReflutter,
} from "../reflutterApi";

const MODE_OPTIONS: { id: ReflutterMode; label: string; desc: string }[] = [
  {
    id: "snapshot",
    label: "Display absolute code offsets (dump.dart)",
    desc: "Patches the engine so the app writes a dump.dart at launch — the reconstructed Dart library/class/function map with code offsets. Best for reverse engineering.",
  },
  {
    id: "traffic",
    label: "Traffic monitoring & interception",
    desc: "Reroutes the app's traffic to a Burp proxy at the IP below (port 8083). Best for inspecting API calls and bypassing TLS pinning.",
  },
];

const MODE_LABEL: Record<string, string> = {
  snapshot: "snapshot",
  traffic: "traffic",
};

function isActive(j: ReflutterJob | null): boolean {
  return !!j && (j.status === "queued" || j.status === "running");
}

// Accepts a bare IPv4 or host, optionally with :port — reFlutter defaults the
// port to 8083 itself, so a port is optional here.
function proxyLooksValid(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const [host, port, ...rest] = v.split(":");
  if (rest.length > 0) return false;
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return false;
  if (!host) return false;
  // IPv4 or a plausible hostname.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  if (ipv4.test(host)) {
    return host.split(".").every((o) => Number(o) <= 255);
  }
  return /^[a-zA-Z0-9.-]+$/.test(host);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------

function filterDump(parsed: ParsedDump, query: string): { libraries: ParsedDump["libraries"]; matches: number } {
  const q = query.trim().toLowerCase();
  if (!q) {
    const matches = parsed.libraries.reduce(
      (acc, lib) => acc + lib.classes.reduce((a, c) => a + c.functions.length, 0),
      0
    );
    return { libraries: parsed.libraries, matches };
  }

  let matches = 0;
  const libraries = parsed.libraries
    .map((lib) => {
      const libHit = lib.name.toLowerCase().includes(q);
      const classes = lib.classes
        .map((cls) => {
          const clsHit = libHit || cls.name.toLowerCase().includes(q);
          const functions = clsHit
            ? cls.functions
            : cls.functions.filter((f) => f.name.toLowerCase().includes(q));
          matches += functions.length;
          if (clsHit || functions.length > 0) return { ...cls, functions };
          return null;
        })
        .filter((c): c is ParsedDump["libraries"][0]["classes"][0] => c !== null);
      if (classes.length > 0) return { ...lib, classes };
      return null;
    })
    .filter((l): l is ParsedDump["libraries"][0] => l !== null);

  return { libraries, matches };
}

function DumpTree({ parsed, query }: { parsed: ParsedDump; query: string }) {
  const { libraries, matches } = useMemo(() => filterDump(parsed, query), [parsed, query]);
  const open = query.trim().length > 0;
  // Cap rendered functions so a huge dump can't lock the tab up; the stats
  // line still reports the true totals.
  const CAP = 4000;
  let rendered = 0;
  let capped = false;

  return (
    <div className="rf-tree">
      {libraries.length === 0 && <div className="empty-hint small">No matches.</div>}
      {libraries.map((lib) => (
        <details key={lib.name} className="rf-lib" open={open}>
          <summary className="rf-lib-name mono">
            {lib.name}
            <span className="muted rf-count">
              {lib.classes.length} cls
            </span>
          </summary>
          {lib.classes.map((cls, ci) => (
            <div key={`${lib.name}:${cls.name}:${ci}`} className="rf-class">
              <div className="rf-class-name mono">
                <span className="rf-kw">class</span> {cls.name}
                {cls.extends && <span className="muted"> : {cls.extends}</span>}
              </div>
              {cls.functions.map((fn, fi) => {
                if (rendered >= CAP) {
                  capped = true;
                  return null;
                }
                rendered += 1;
                return (
                  <div key={`${cls.name}:${fn.name}:${fi}`} className="rf-func mono">
                    <span className="rf-func-name">{fn.name}</span>
                    {fn.offset && <span className="rf-offset">{fn.offset}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </details>
      ))}
      {capped && (
        <div className="notice small">
          Showing the first {CAP.toLocaleString()} functions of {matches.toLocaleString()} matched — use the
          filter above to narrow it down.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function ReflutterPage({ platform }: { platform: "ios" | "android" }) {
  const accept = platform === "ios" ? ".ipa" : ".apk";
  const inputLabel = platform === "ios" ? "Drop an .ipa to patch" : "Drop an .apk to patch";

  const [jobs, setJobs] = useState<ReflutterJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<ReflutterMode>("snapshot");
  const [proxyIp, setProxyIp] = useState("");
  const [showLog, setShowLog] = useState(false);

  const [dumps, setDumps] = useState<DumpDartSummary[]>([]);
  const [activeDump, setActiveDump] = useState<DumpDart | null>(null);
  const [dumpQuery, setDumpQuery] = useState("");
  const [dumpError, setDumpError] = useState<string | null>(null);

  // The page is platform-scoped (upload accepts only this platform's extension),
  // so only show this platform's patch jobs here.
  const visibleJobs = useMemo(() => jobs.filter((j) => j.platform === platform), [jobs, platform]);
  const selected = jobs.find((j) => j.id === selectedId) ?? null;
  const anyActive = visibleJobs.some((j) => isActive(j));

  const refreshJobs = useCallback(() => {
    listReflutterJobs().then(setJobs).catch(console.error);
  }, []);
  const refreshDumps = useCallback(() => {
    listDumpDarts().then(setDumps).catch(console.error);
  }, []);

  useEffect(() => {
    refreshJobs();
    refreshDumps();
  }, [refreshJobs, refreshDumps]);

  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(refreshJobs, 1500);
    return () => clearInterval(t);
  }, [anyActive, refreshJobs]);

  const uploadFn = useCallback(
    (file: File, onProgress: (pct: number) => void) => {
      if (mode === "traffic") {
        if (!proxyIp.trim()) {
          return Promise.reject(new Error("Enter a Burp proxy IP for traffic-monitoring mode."));
        }
        if (!proxyLooksValid(proxyIp)) {
          return Promise.reject(new Error("Proxy should look like 192.168.1.5 or 192.168.1.5:8083."));
        }
      }
      return uploadReflutter(file, mode, mode === "traffic" ? proxyIp.trim() : null, onProgress);
    },
    [mode, proxyIp]
  );

  function onUploaded(job: ReflutterJob) {
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    setSelectedId(job.id);
    refreshJobs();
  }

  async function handleDeleteJob(job: ReflutterJob, e: React.MouseEvent) {
    e.stopPropagation();
    if (isActive(job)) {
      window.alert("Wait for this patch to finish before deleting it.");
      return;
    }
    if (!window.confirm("Delete this reFlutter job, its uploaded input and the patched artifact?")) return;
    try {
      await deleteReflutterJob(job.id);
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
      if (selectedId === job.id) setSelectedId(null);
    } catch (err) {
      window.alert(`Failed to delete: ${(err as Error).message}`);
    }
  }

  const dumpUploadFn = useCallback(
    (file: File, onProgress: (pct: number) => void) => {
      return uploadDumpDart(file, selectedId, onProgress);
    },
    [selectedId]
  );

  function onDumpUploaded(dump: DumpDart) {
    setDumpError(null);
    setActiveDump(dump);
    setDumpQuery("");
    refreshDumps();
  }

  async function openDump(id: string) {
    try {
      setActiveDump(await getDumpDart(id));
      setDumpQuery("");
    } catch (err) {
      setDumpError((err as Error).message);
    }
  }

  async function handleDeleteDump(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm("Delete this parsed dump.dart?")) return;
    try {
      await deleteDumpDart(id);
      setDumps((prev) => prev.filter((d) => d.id !== id));
      if (activeDump?.id === id) setActiveDump(null);
    } catch (err) {
      window.alert(`Failed to delete: ${(err as Error).message}`);
    }
  }

  return (
    <div className="dynamic-page">
      <div className="dynamic-config-panel">
        <div className="panel-heading">Patch a Flutter app</div>

        <div className="dyn-field">
          <span>reFlutter mode</span>
          <div className="rf-mode-list">
            {MODE_OPTIONS.map((opt) => (
              <label key={opt.id} className={`rf-mode-option ${mode === opt.id ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="reflutter-mode"
                  checked={mode === opt.id}
                  onChange={() => setMode(opt.id)}
                />
                <span>
                  <strong>{opt.label}</strong>
                  <span className="muted rf-mode-desc">{opt.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {mode === "traffic" && (
          <label className="dyn-field">
            <span>Burp proxy IP (required)</span>
            <input
              className="search-input"
              placeholder="192.168.1.5  or  192.168.1.5:8083"
              value={proxyIp}
              onChange={(e) => setProxyIp(e.target.value)}
            />
            <span className="muted rf-mode-desc">
              The device must be able to reach this IP; run Burp there listening on port 8083.
            </span>
          </label>
        )}

        <div className="dyn-field">
          <span>App to patch</span>
          <UploadForm<ReflutterJob>
            accept={accept}
            label={inputLabel}
            uploadFn={uploadFn}
            onUploaded={onUploaded}
          />
          <span className="muted rf-mode-desc">
            reFlutter downloads the matching pre-patched Flutter engine and repackages the app. The result is
            <strong> unsigned</strong> — you re-sign and install it yourself.
          </span>
        </div>

        {visibleJobs.length > 0 && (
          <>
            <div className="panel-heading dyn-runs-heading">Patch jobs</div>
            <div className="dyn-runs-list">
              {visibleJobs.map((job) => (
                <div
                  key={job.id}
                  className={`dyn-run-row ${selectedId === job.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(job.id)}
                >
                  <span className={`pill pill-${job.status}`}>{job.status}</span>
                  <span className="rf-badge mono">{MODE_LABEL[job.mode] ?? job.mode}</span>
                  <span className="mono dyn-run-bundle">{job.original_filename}</span>
                  <span className="muted dyn-run-time">{new Date(job.created_at).toLocaleTimeString()}</span>
                  <button
                    className="ipa-delete-btn dyn-run-delete-btn"
                    title="Delete this job"
                    onClick={(e) => handleDeleteJob(job, e)}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="dynamic-results-panel rf-results">
        {!selected ? (
          <div className="empty-state">
            <div className="empty-state-icon">🦋</div>
            <div>Upload an {accept} on the left to patch it with reFlutter.</div>
          </div>
        ) : (
          <div className="rf-detail">
            <div className="dyn-run-header">
              <span className={`pill pill-${selected.status}`}>{selected.status}</span>
              <span className="mono rf-detail-name">{selected.original_filename}</span>
              <span className="rf-badge mono">{MODE_LABEL[selected.mode] ?? selected.mode}</span>
              {selected.proxy_ip && <span className="muted mono">→ {selected.proxy_ip}</span>}
            </div>

            {isActive(selected) && (
              <div className="progress-bar-outer">
                <div className="progress-bar-inner" style={{ width: `${selected.progress_pct}%` }} />
              </div>
            )}
            {selected.message && isActive(selected) && <div className="muted dyn-run-message">{selected.message}</div>}
            {selected.error_message && <div className="error-text rf-pre">{selected.error_message}</div>}

            {selected.snapshot_hash && (
              <div className="rf-kv">
                <span className="muted">Dart snapshot hash</span>
                <span className="mono">{selected.snapshot_hash}</span>
              </div>
            )}

            {selected.status === "done" && (
              selected.has_artifact ? (
                <div className="rf-download">
                  <a className="btn" href={reflutterArtifactUrl(selected.id)}>
                    ⬇ Download patched {selected.artifact_filename ?? "artifact"}
                  </a>
                  <span className="muted rf-mode-desc">
                    Unsigned. For Android:{" "}
                    <code className="mono">java -jar uber-apk-signer.jar -a {selected.artifact_filename ?? "app.RE.apk"}</code>
                    , then install. For iOS, re-sign with your signing tool of choice (Sideloadly / codesign) before
                    installing.
                    {selected.mode === "snapshot" && (
                      <>
                        {" "}Run it once, then pull <code className="mono">dump.dart</code> off the device and load it
                        in the viewer below.
                      </>
                    )}
                  </span>
                </div>
              ) : (
                <div className="notice small">Finished, but no downloadable artifact was captured — check the log.</div>
              )
            )}

            {selected.output_log && (
              <div className="rf-log-wrap">
                <button className="btn btn-secondary" onClick={() => setShowLog((v) => !v)}>
                  {showLog ? "Hide reFlutter output" : "Show reFlutter output"}
                </button>
                {showLog && <pre className="code-block rf-log">{selected.output_log}</pre>}
              </div>
            )}
          </div>
        )}

        {/* dump.dart viewer — always available */}
        <div className="rf-dump-section">
          <div className="panel-heading">dump.dart viewer</div>
          <div className="rf-dump-upload">
            <UploadForm<DumpDart>
              accept=".dart"
              label="Drop a dump.dart"
              uploadFn={dumpUploadFn}
              onUploaded={onDumpUploaded}
            />
            <span className="muted rf-mode-desc">
              {selectedId
                ? "Will be linked to the selected patch job above."
                : "Select a patch job above to link the dump to it, or upload standalone."}
            </span>
            {dumpError && <div className="error-text">{dumpError}</div>}
          </div>

          {dumps.length > 0 && (
            <div className="rf-dump-list">
              {dumps.map((d) => (
                <div
                  key={d.id}
                  className={`dyn-run-row ${activeDump?.id === d.id ? "selected" : ""}`}
                  onClick={() => openDump(d.id)}
                >
                  <span className="mono dyn-run-bundle">{d.original_filename}</span>
                  <span className="muted rf-count">
                    {d.stats.libraries} lib · {d.stats.classes} cls · {d.stats.functions} fn
                  </span>
                  <span className="muted dyn-run-time">{new Date(d.created_at).toLocaleTimeString()}</span>
                  <button
                    className="ipa-delete-btn dyn-run-delete-btn"
                    title="Delete this dump"
                    onClick={(e) => handleDeleteDump(d.id, e)}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
          )}

          {activeDump && (
            <>
              <div className="rf-stats">
                <span className="mono">{activeDump.parsed.stats.libraries}</span> libraries ·{" "}
                <span className="mono">{activeDump.parsed.stats.classes}</span> classes ·{" "}
                <span className="mono">{activeDump.parsed.stats.functions}</span> functions
                {activeDump.parsed.stats.unparsed > 0 && (
                  <span className="muted"> · {activeDump.parsed.stats.unparsed} unparsed lines</span>
                )}
              </div>
              <input
                className="search-input"
                placeholder="Filter libraries / classes / functions…"
                value={dumpQuery}
                onChange={(e) => setDumpQuery(e.target.value)}
              />
              <DumpTree parsed={activeDump.parsed} query={dumpQuery} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
