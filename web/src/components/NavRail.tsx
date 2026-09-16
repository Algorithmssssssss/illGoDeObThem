export type AppView = "workbench" | "compare" | "dynamic" | "docs";

const IOS_SECTIONS: { id: AppView; icon: string; label: string }[] = [
  { id: "workbench", icon: "📦", label: "Workbench" },
  { id: "compare", icon: "⚖️", label: "Compare" },
  { id: "dynamic", icon: "🧬", label: "Dynamic" },
];

const ANDROID_SECTIONS: { id: AppView; icon: string; label: string }[] = [
  { id: "workbench", icon: "📦", label: "Workbench" },
  { id: "compare", icon: "⚖️", label: "Compare" },
];

export default function NavRail({
  view,
  onChange,
  platform,
}: {
  view: AppView;
  onChange: (v: AppView) => void;
  platform: "ios" | "android";
}) {
  const sections = platform === "android" ? ANDROID_SECTIONS : IOS_SECTIONS;

  return (
    <nav className="rail">
      <div className="rail-logo">🔎</div>
      <div className="rail-group">
        {sections.map((s) => (
          <button
            key={s.id}
            className={`rail-item ${view === s.id ? "active" : ""}`}
            onClick={() => onChange(s.id)}
            aria-label={s.label}
          >
            <span aria-hidden="true">{s.icon}</span>
            <span className="rail-label">{s.label}</span>
          </button>
        ))}
      </div>
      <div className="rail-spacer" />
      {platform === "ios" && (
        <div className="rail-bottom">
          <div className="rail-divider" />
          <button
            className={`rail-item ${view === "docs" ? "active" : ""}`}
            onClick={() => onChange("docs")}
            aria-label="Docs"
          >
            <span aria-hidden="true">📖</span>
            <span className="rail-label">Docs</span>
          </button>
        </div>
      )}
    </nav>
  );
}
