export type Platform = "ios" | "android";

export default function PlatformSwitch({
  platform,
  onChange,
}: {
  platform: Platform;
  onChange: (p: Platform) => void;
}) {
  return (
    <div className="platform-switch">
      <button
        className={`platform-switch-btn ${platform === "android" ? "active" : ""}`}
        onClick={() => onChange("android")}
      >
        🤖 AndroidDeOb
      </button>
      <button
        className={`platform-switch-btn ${platform === "ios" ? "active" : ""}`}
        onClick={() => onChange("ios")}
      >
        🍎 iOSDeOb
      </button>
    </div>
  );
}
