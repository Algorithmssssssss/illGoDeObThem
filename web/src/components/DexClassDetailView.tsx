import { useState } from "react";
import { AndroidJob, ClassSource, DexClass } from "../androidApi";

function MemberLine({ label }: { label: string }) {
  return (
    <div className="disasm-line">
      <span>{label}</span>
    </div>
  );
}

function ClassShape({ cls }: { cls: DexClass }) {
  const extendsPart = cls.superclass ? ` extends ${cls.superclass}` : "";
  const implementsPart = cls.interfaces.length ? ` implements ${cls.interfaces.join(", ")}` : "";
  const accessPart = cls.access_flags ? `${cls.access_flags} ` : "";

  return (
    <pre className="code-block disasm-listing">
      {`${accessPart}class ${cls.name}${extendsPart}${implementsPart} {`}
      {"\n"}
      {cls.fields.map((f, i) => (
        <MemberLine key={`f${i}`} label={`    ${f.access_flags ?? ""} ${f.descriptor ?? ""} ${f.name};`} />
      ))}
      {cls.fields.length > 0 && "\n"}
      {cls.methods.map((m, i) => (
        <MemberLine key={`m${i}`} label={`    ${m.access_flags ?? ""} ${m.name}${m.descriptor ?? ""}`} />
      ))}
      {"\n}"}
    </pre>
  );
}

export default function DexClassDetailView({
  cls,
  source,
  sourceLoading,
  sourceError,
  sourceProgress,
}: {
  cls: DexClass;
  source: ClassSource | null;
  sourceLoading: boolean;
  sourceError: string | null;
  sourceProgress: AndroidJob | null;
}) {
  const hasJava = !!source?.java_code;
  const hasSmali = !!source?.smali_code;
  const [view, setView] = useState<"java" | "smali">("java");

  return (
    <div className="file-viewer">
      <div className="file-viewer-toolbar">
        <div className="file-viewer-title">
          <h3>{cls.name}</h3>
          <span className="file-viewer-meta">
            {cls.methods.length} methods · {cls.fields.length} fields
          </span>
        </div>
      </div>

      <ClassShape cls={cls} />

      <div className="file-viewer-toolbar" style={{ marginTop: 16 }}>
        <div className="file-viewer-title">
          <h3>Decompiled source</h3>
        </div>
        <div className="view-toggle">
          <button
            className={`toggle-btn ${view === "java" ? "active" : ""}`}
            onClick={() => setView("java")}
            disabled={!hasJava}
            title={hasJava ? undefined : source?.java_error ?? "Not available"}
          >
            Java
          </button>
          <button
            className={`toggle-btn ${view === "smali" ? "active" : ""}`}
            onClick={() => setView("smali")}
            disabled={!hasSmali}
            title={hasSmali ? undefined : source?.smali_error ?? "Not available"}
          >
            Smali
          </button>
        </div>
      </div>

      {sourceLoading && (
        <div className="job-status">
          <div className="job-status-label">Decompiling…</div>
          {sourceProgress && (
            <div className="progress-bar-outer">
              <div className="progress-bar-inner" style={{ width: `${sourceProgress.progress_pct}%` }} />
            </div>
          )}
        </div>
      )}
      {sourceError && <div className="error-text">{sourceError}</div>}

      {!sourceLoading && source && (
        <>
          {source.truncated && (
            <div className="notice">This class's source is unusually large — output was truncated.</div>
          )}
          {view === "java" && hasJava && <pre className="code-block disasm-listing">{source.java_code}</pre>}
          {view === "java" && !hasJava && (
            <div className="notice">{source.java_error ?? "JADX could not decompile this class."}</div>
          )}
          {view === "smali" && hasSmali && <pre className="code-block disasm-listing">{source.smali_code}</pre>}
          {view === "smali" && !hasSmali && (
            <div className="notice">{source.smali_error ?? "Smali disassembly isn't available for this class."}</div>
          )}
        </>
      )}
    </div>
  );
}
