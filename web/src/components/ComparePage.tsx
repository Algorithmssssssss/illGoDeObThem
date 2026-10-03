import { useEffect, useMemo, useState } from "react";
import {
  BinaryDiff,
  BinaryStats,
  ClassChanged,
  ClassSummary,
  CompareResult,
  FileChanged,
  FileEntry,
  FunctionChanged,
  IPA,
  compareScans,
  getJob,
  reanalyzeIpa,
} from "../api";
import { CompareSelection, WorkbenchTarget } from "../jump";
import DiffColumn from "./DiffColumn";

function formatSize(bytes?: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSigned(n: number, format: (abs: number) => string): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : "−"}${format(Math.abs(n))}`;
}

// "2.8 KB → 2.8 KB" hides a real change behind rounding, so fall back to the
// exact byte difference whenever both sides print the same.
function formatChange(a?: number | null, b?: number | null): string {
  if (a == null || b == null) return "";
  const [fa, fb] = [formatSize(a), formatSize(b)];
  return fa === fb ? `${fa} (${formatSigned(b - a, formatSize)})` : `${fa} → ${fb}`;
}

const formatCount = (n: number) => n.toLocaleString("en-US");

const JOB_POLL_MS = 1500;

interface MetricRow {
  label: string;
  a?: number | null;
  b?: number | null;
  format: (n: number) => string;
}

function binaryMetrics(a: BinaryStats, b: BinaryStats): MetricRow[] {
  const unnamedCode = (s: BinaryStats) => (s.text_size == null ? null : s.text_size - s.named_code_size);
  return [
    { label: "File size", a: a.file_size, b: b.file_size, format: formatSize },
    { label: "Code (__text)", a: a.text_size, b: b.text_size, format: formatSize },
    { label: "Functions", a: a.function_count, b: b.function_count, format: formatCount },
    { label: "Named functions", a: a.named_function_count, b: b.named_function_count, format: formatCount },
    { label: "Unnamed functions", a: a.unnamed_function_count, b: b.unnamed_function_count, format: formatCount },
    { label: "Code in named functions", a: a.named_code_size, b: b.named_code_size, format: formatSize },
    { label: "Code in unnamed functions", a: unnamedCode(a), b: unnamedCode(b), format: formatSize },
  ];
}

function SizeCells({ a, b, format }: { a?: number | null; b?: number | null; format: (n: number) => string }) {
  const delta = a != null && b != null ? b - a : null;
  return (
    <>
      <td>{a == null ? "—" : format(a)}</td>
      <td>{b == null ? "—" : format(b)}</td>
      <td className={delta ? "binary-delta changed" : "binary-delta"}>
        {delta == null ? "—" : formatSigned(delta, format)}
      </td>
    </>
  );
}

function BinarySection({
  result,
  reanalyzing,
  onReanalyze,
}: {
  result: CompareResult;
  reanalyzing: boolean;
  onReanalyze: () => void;
}) {
  const [showUnchanged, setShowUnchanged] = useState(false);
  const binary: BinaryDiff = result.binary;
  const { a, b } = binary;

  if (!a || !b) {
    const missing = [!a && result.a.filename, !b && result.b.filename].filter(Boolean).join(" and ");
    return (
      <section className="compare-section">
        <h2>Main binary</h2>
        <div className="notice binary-missing">
          <span>
            No code-size data for {missing} — scanned before function sizes were measured. Without it, only names can
            be compared.
          </span>
          <button className="btn" disabled={reanalyzing} onClick={onReanalyze}>
            {reanalyzing ? "Re-analysing…" : "Re-analyse"}
          </button>
        </div>
      </section>
    );
  }

  // Empty regions (e.g. __PAGEZERO, which has no bytes on disk) are noise.
  const regions = binary.regions.filter((r) => r.size_a || r.size_b);
  const changedRegions = regions.filter((r) => r.size_a !== r.size_b);
  const visibleRegions = showUnchanged ? regions : changedRegions;
  const upperBound = a.size_source !== "function_starts" || b.size_source !== "function_starts";

  return (
    <section className="compare-section">
      <h2>
        Main binary <span className="muted mono">· {a.path === b.path ? a.path : `${a.path} / ${b.path}`}</span>
      </h2>
      <div className="binary-tables">
        <table className="binary-table">
          <thead>
            <tr>
              <th></th>
              <th>A</th>
              <th>B</th>
              <th>B − A</th>
            </tr>
          </thead>
          <tbody>
            {binaryMetrics(a, b).map((m) => (
              <tr key={m.label}>
                <th>{m.label}</th>
                <SizeCells a={m.a} b={m.b} format={m.format} />
              </tr>
            ))}
          </tbody>
        </table>
        <table className="binary-table">
          <thead>
            <tr>
              <th>
                Segments and sections
                <label className="binary-toggle">
                  <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} />
                  show {regions.length - changedRegions.length} unchanged
                </label>
              </th>
              <th>A</th>
              <th>B</th>
              <th>B − A</th>
            </tr>
          </thead>
          <tbody>
            {visibleRegions.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">Every segment and section is the same size.</td>
              </tr>
            )}
            {visibleRegions.map((r) => (
              <tr key={r.name} className={r.kind === "segment" ? "binary-segment" : undefined}>
                <th className="mono">{r.name}</th>
                <SizeCells a={r.size_a} b={r.size_b} format={formatSize} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {upperBound && (
        <div className="notice small">
          At least one binary has no function-starts table, so its function sizes are upper bounds measured between
          named functions.
        </div>
      )}
    </section>
  );
}

export default function ComparePage({
  ipas,
  selection,
  onSelectionChange,
  onJumpToScan,
}: {
  ipas: IPA[];
  selection: CompareSelection;
  onSelectionChange: (selection: CompareSelection) => void;
  onJumpToScan: (ipaId: string, target: WorkbenchTarget) => void;
}) {
  const readyIpas = useMemo(() => ipas.filter((ipa) => ipa.status === "ready"), [ipas]);
  // A remembered pick can outlive its scan (deleted in the Workbench meanwhile).
  const aId = readyIpas.some((s) => s.id === selection.a) ? selection.a : "";
  const bId = readyIpas.some((s) => s.id === selection.b) ? selection.b : "";
  const setAId = (a: string) => onSelectionChange({ ...selection, a });
  const setBId = (b: string) => onSelectionChange({ ...selection, b });
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [reanalyzing, setReanalyzing] = useState(false);

  async function reanalyzeMissing() {
    if (!result) return;
    const ids = [!result.binary.a && result.a.id, !result.binary.b && result.b.id].filter(Boolean) as string[];
    setReanalyzing(true);
    try {
      await Promise.all(
        ids.map(async (id) => {
          let job = await reanalyzeIpa(id);
          while (job.status !== "done" && job.status !== "failed") {
            await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
            job = await getJob(job.id);
          }
          if (job.status === "failed") throw new Error(job.error_message || "Re-analysis failed");
        })
      );
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReanalyzing(false);
    }
  }

  useEffect(() => {
    if (!aId || !bId || aId === bId) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    compareScans(aId, bId)
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
  }, [aId, bId, refreshKey]);

  return (
    <div className="compare-page">
      <div className="compare-picker">
        <select className="compare-select" value={aId} onChange={(e) => setAId(e.target.value)}>
          <option value="">Scan A…</option>
          {readyIpas.map((ipa) => (
            <option key={ipa.id} value={ipa.id} disabled={ipa.id === bId}>
              {ipa.original_filename}
            </option>
          ))}
        </select>
        <span className="compare-vs">vs</span>
        <select className="compare-select" value={bId} onChange={(e) => setBId(e.target.value)}>
          <option value="">Scan B…</option>
          {readyIpas.map((ipa) => (
            <option key={ipa.id} value={ipa.id} disabled={ipa.id === aId}>
              {ipa.original_filename}
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
          <BinarySection result={result} reanalyzing={reanalyzing} onReanalyze={reanalyzeMissing} />

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
                onJump={(scanId, f) => onJumpToScan(scanId, { kind: "file", path: f.path })}
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
                onJump={(scanId, f) => onJumpToScan(scanId, { kind: "file", path: f.path })}
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
                    <span className="diff-row-meta">{formatChange(f.size_a, f.size_b)}</span>
                  </>
                )}
                jumpTargets={() => [
                  { label: "A", scanId: result.a.id },
                  { label: "B", scanId: result.b.id },
                ]}
                onJump={(scanId, f) => onJumpToScan(scanId, { kind: "file", path: f.path })}
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
                filterText={(c: ClassSummary) => c.name}
                renderRow={(c: ClassSummary) => (
                  <>
                    <span className="diff-row-main mono" title={c.name}>{c.name}</span>
                    <span className="diff-row-meta">{c.superclass}</span>
                  </>
                )}
                jumpTargets={() => [{ label: "A", scanId: result.a.id }]}
                onJump={(scanId, c) => onJumpToScan(scanId, { kind: "class", name: c.name })}
              />
              <DiffColumn
                title="Only in B"
                count={result.classes.only_in_b_total}
                tone="b"
                items={result.classes.only_in_b}
                filterText={(c: ClassSummary) => c.name}
                renderRow={(c: ClassSummary) => (
                  <>
                    <span className="diff-row-main mono" title={c.name}>{c.name}</span>
                    <span className="diff-row-meta">{c.superclass}</span>
                  </>
                )}
                jumpTargets={() => [{ label: "B", scanId: result.b.id }]}
                onJump={(scanId, c) => onJumpToScan(scanId, { kind: "class", name: c.name })}
              />
              <DiffColumn
                title="Changed"
                count={result.classes.changed_total}
                tone="changed"
                items={result.classes.changed}
                filterText={(c: ClassChanged) => c.name}
                renderRow={(c: ClassChanged) => (
                  <>
                    <span className="diff-row-main mono" title={c.name}>{c.name}</span>
                    <span className="diff-row-meta">
                      {c.a.instance_method_count}→{c.b.instance_method_count} methods
                    </span>
                  </>
                )}
                jumpTargets={() => [
                  { label: "A", scanId: result.a.id },
                  { label: "B", scanId: result.b.id },
                ]}
                onJump={(scanId, c) => onJumpToScan(scanId, { kind: "class", name: c.name })}
              />
            </div>
          </section>

          <section className="compare-section">
            <h2>
              Functions{" "}
              <span className="muted">
                · {result.functions.common_total} shared by name
                {result.functions.changed_total > 0 &&
                  ` · ${result.functions.larger_in_b_total} larger in B, ${result.functions.larger_in_a_total} larger in A`}
                {result.functions.changed_total > result.functions.changed.length &&
                  ` · listing the ${result.functions.changed.length} biggest size changes`}
              </span>
            </h2>
            <div className="diff-grid diff-grid-2">
              <DiffColumn
                title="Only in A"
                count={result.functions.only_in_a_total}
                tone="a"
                items={result.functions.only_in_a}
                filterText={(n: string) => n}
                renderRow={(n: string) => <span className="diff-row-main mono" title={n}>{n}</span>}
                jumpTargets={() => [{ label: "A", scanId: result.a.id }]}
                onJump={(scanId, name) => onJumpToScan(scanId, { kind: "function", name })}
              />
              <DiffColumn
                title="Only in B"
                count={result.functions.only_in_b_total}
                tone="b"
                items={result.functions.only_in_b}
                filterText={(n: string) => n}
                renderRow={(n: string) => <span className="diff-row-main mono" title={n}>{n}</span>}
                jumpTargets={() => [{ label: "B", scanId: result.b.id }]}
                onJump={(scanId, name) => onJumpToScan(scanId, { kind: "function", name })}
              />
              <DiffColumn
                title="Changed size"
                count={result.functions.changed_total}
                tone="changed"
                wide
                items={result.functions.changed}
                filterText={(f: FunctionChanged) => f.name}
                renderRow={(f: FunctionChanged) => (
                  <>
                    <span className="diff-row-main mono" title={f.name}>{f.name}</span>
                    <span className="diff-row-meta">{formatChange(f.size_a, f.size_b)}</span>
                  </>
                )}
                jumpTargets={() => [
                  { label: "A", scanId: result.a.id },
                  { label: "B", scanId: result.b.id },
                ]}
                onJump={(scanId, f) => onJumpToScan(scanId, { kind: "function", name: f.name })}
              />
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
