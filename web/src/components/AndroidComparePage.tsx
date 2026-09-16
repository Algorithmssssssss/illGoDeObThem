import { useEffect, useMemo, useState } from "react";
import { FileChanged, FileEntry } from "../api";
import { APK, ApkCompareResult, DexClassChanged, DexClassSummary, compareApkScans } from "../androidApi";
import DiffColumn from "./DiffColumn";

function formatSize(bytes?: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDelta(a?: number | null, b?: number | null): string {
  if (a == null || b == null) return "";
  const delta = a - b;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${formatDelta.bytes(delta)}`;
}
formatDelta.bytes = (n: number) => {
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export default function AndroidComparePage({
  apks,
  onJumpToScan,
}: {
  apks: APK[];
  onJumpToScan: (apkId: string) => void;
}) {
  const readyApks = useMemo(() => apks.filter((apk) => apk.status === "ready"), [apks]);
  const [aId, setAId] = useState("");
  const [bId, setBId] = useState("");
  const [result, setResult] = useState<ApkCompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!aId || !bId || aId === bId) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    compareApkScans(aId, bId)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aId, bId]);

  function scanLabel(apk: APK): string {
    return apk.app_name || apk.package_name || apk.original_filename;
  }

  return (
    <div className="compare-page">
      <div className="compare-picker">
        <select className="compare-select" value={aId} onChange={(e) => setAId(e.target.value)}>
          <option value="">Scan A…</option>
          {readyApks.map((apk) => (
            <option key={apk.id} value={apk.id} disabled={apk.id === bId}>
              {scanLabel(apk)}
            </option>
          ))}
        </select>
        <span className="compare-vs">vs</span>
        <select className="compare-select" value={bId} onChange={(e) => setBId(e.target.value)}>
          <option value="">Scan B…</option>
          {readyApks.map((apk) => (
            <option key={apk.id} value={apk.id} disabled={apk.id === aId}>
              {scanLabel(apk)}
            </option>
          ))}
        </select>
      </div>

      {!aId || !bId ? (
        <div className="empty-hint">Pick two scans to compare.</div>
      ) : aId === bId ? (
        <div className="notice">Pick two different scans.</div>
      ) : loading ? (
        <div className="empty-hint">Comparing…</div>
      ) : error ? (
        <div className="error-text">{error}</div>
      ) : result ? (
        <div className="compare-results">
          <section className="compare-section">
            <h2>
              Files <span className="muted">· {result.files.common_total} identical or unchanged</span>
            </h2>
            <div className="diff-grid diff-grid-3">
              <DiffColumn
                title="Only in A"
                count={result.files.only_in_a_total}
                tone="a"
                items={result.files.only_in_a}
                filterText={(f: FileEntry) => f.path}
                renderRow={(f: FileEntry) => (
                  <>
                    <span className="diff-row-main mono" title={f.path}>{f.path}</span>
                    {f.kind === "file" && <span className="diff-row-meta">{formatSize(f.size_bytes)}</span>}
                  </>
                )}
                jumpTargets={() => [{ label: "A", scanId: result.a.id }]}
                onJump={onJumpToScan}
              />
              <DiffColumn
                title="Only in B"
                count={result.files.only_in_b_total}
                tone="b"
                items={result.files.only_in_b}
                filterText={(f: FileEntry) => f.path}
                renderRow={(f: FileEntry) => (
                  <>
                    <span className="diff-row-main mono" title={f.path}>{f.path}</span>
                    {f.kind === "file" && <span className="diff-row-meta">{formatSize(f.size_bytes)}</span>}
                  </>
                )}
                jumpTargets={() => [{ label: "B", scanId: result.b.id }]}
                onJump={onJumpToScan}
              />
              <DiffColumn
                title="Changed size"
                count={result.files.changed_total}
                tone="changed"
                items={result.files.changed}
                filterText={(f: FileChanged) => f.path}
                renderRow={(f: FileChanged) => (
                  <>
                    <span className="diff-row-main mono" title={f.path}>{f.path}</span>
                    <span className="diff-row-meta">{formatDelta(f.size_a, f.size_b)}</span>
                  </>
                )}
                jumpTargets={() => [
                  { label: "A", scanId: result.a.id },
                  { label: "B", scanId: result.b.id },
                ]}
                onJump={onJumpToScan}
              />
            </div>
          </section>

          <section className="compare-section">
            <h2>
              Classes <span className="muted">· {result.classes.common_total} shared</span>
            </h2>
            <div className="diff-grid diff-grid-3">
              <DiffColumn
                title="Only in A"
                count={result.classes.only_in_a_total}
                tone="a"
                items={result.classes.only_in_a}
                filterText={(c: DexClassSummary) => c.name}
                renderRow={(c: DexClassSummary) => (
                  <>
                    <span className="diff-row-main mono" title={c.name}>{c.name}</span>
                    <span className="diff-row-meta">{c.superclass}</span>
                  </>
                )}
                jumpTargets={() => [{ label: "A", scanId: result.a.id }]}
                onJump={onJumpToScan}
              />
              <DiffColumn
                title="Only in B"
                count={result.classes.only_in_b_total}
                tone="b"
                items={result.classes.only_in_b}
                filterText={(c: DexClassSummary) => c.name}
                renderRow={(c: DexClassSummary) => (
                  <>
                    <span className="diff-row-main mono" title={c.name}>{c.name}</span>
                    <span className="diff-row-meta">{c.superclass}</span>
                  </>
                )}
                jumpTargets={() => [{ label: "B", scanId: result.b.id }]}
                onJump={onJumpToScan}
              />
              <DiffColumn
                title="Changed"
                count={result.classes.changed_total}
                tone="changed"
                items={result.classes.changed}
                filterText={(c: DexClassChanged) => c.name}
                renderRow={(c: DexClassChanged) => (
                  <>
                    <span className="diff-row-main mono" title={c.name}>{c.name}</span>
                    <span className="diff-row-meta">
                      {c.a.method_count}→{c.b.method_count} methods
                    </span>
                  </>
                )}
                jumpTargets={() => [
                  { label: "A", scanId: result.a.id },
                  { label: "B", scanId: result.b.id },
                ]}
                onJump={onJumpToScan}
              />
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
