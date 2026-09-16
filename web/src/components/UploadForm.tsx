import { useRef, useState } from "react";

export default function UploadForm<T>({
  accept = ".ipa",
  label = "Drop an .ipa",
  uploadFn,
  onUploaded,
}: {
  accept?: string;
  label?: string;
  uploadFn: (file: File, onProgress: (pct: number) => void) => Promise<T>;
  onUploaded: (result: T) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File) {
    if (!file.name.toLowerCase().endsWith(accept)) {
      setError(`Only ${accept} files are accepted`);
      return;
    }
    setError(null);
    setProgress(0);
    try {
      const result = await uploadFn(file, setProgress);
      onUploaded(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="upload-form">
      <div
        className={`dropzone ${dragOver ? "drag-over" : ""}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleFile(file);
        }}
      >
        <div className="dropzone-icon">⇪</div>
        <div className="dropzone-text">
          <strong>{label}</strong> or click to browse
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          e.target.value = "";
        }}
      />
      {progress !== null && (
        <div className="progress-bar-outer small">
          <div className="progress-bar-inner" style={{ width: `${progress}%` }} />
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
