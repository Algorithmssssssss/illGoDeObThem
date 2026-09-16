import { useMemo, useState } from "react";

export interface JumpTarget {
  label: string;
  scanId: string;
}

export default function DiffColumn<T>({
  title,
  count,
  tone,
  items,
  filterText,
  renderRow,
  jumpTargets,
  onJump,
}: {
  title: string;
  count: number;
  tone: "a" | "b" | "changed" | "neutral";
  items: T[];
  filterText: (item: T) => string;
  renderRow: (item: T) => React.ReactNode;
  jumpTargets?: (item: T) => JumpTarget[];
  onJump?: (scanId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter((item) => filterText(item).toLowerCase().includes(q));
  }, [items, query, filterText]);

  return (
    <div className="diff-col">
      <div className={`diff-col-header tone-${tone}`}>
        <span>{title}</span>
        <span className="diff-count">{count}</span>
      </div>
      {items.length > 8 && (
        <input className="search-input diff-col-search" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
      )}
      <div className="diff-col-list">
        {filtered.length === 0 && <div className="empty-hint small">Nothing here.</div>}
        {filtered.map((item, i) => (
          <div key={i} className="diff-row">
            {renderRow(item)}
            {jumpTargets && onJump && (
              <span className="diff-row-jumps">
                {jumpTargets(item).map((t) => (
                  <button
                    key={t.scanId}
                    className="diff-jump-btn"
                    title={`Open in Workbench · ${t.label}`}
                    onClick={() => onJump(t.scanId)}
                  >
                    {t.label} ↗
                  </button>
                ))}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
