import { useCallback, useEffect, useState } from "react";
import { IPA, listIpas } from "./api";
import { APK, listApks } from "./androidApi";
import NavRail, { type AppView } from "./components/NavRail";
import PlatformSwitch, { type Platform } from "./components/PlatformSwitch";
import WorkbenchPage from "./components/WorkbenchPage";
import ComparePage from "./components/ComparePage";
import DynamicPage from "./components/DynamicPage";
import McpDocsPage from "./components/McpDocsPage";
import AndroidWorkbenchPage from "./components/AndroidWorkbenchPage";
import AndroidComparePage from "./components/AndroidComparePage";

const SECTION_TITLE: Record<AppView, string> = {
  workbench: "Workbench",
  compare: "Compare scans",
  dynamic: "Dynamic analysis",
  docs: "MCP documentation",
};

const PLATFORM_STORAGE_KEY = "iosdeob.platform";

function loadStoredPlatform(): Platform {
  try {
    const stored = localStorage.getItem(PLATFORM_STORAGE_KEY);
    return stored === "android" ? "android" : "ios";
  } catch {
    return "ios";
  }
}

export default function App() {
  const [platform, setPlatform] = useState<Platform>(loadStoredPlatform);
  const [view, setView] = useState<AppView>("workbench");

  const [ipas, setIpas] = useState<IPA[]>([]);
  const [selectedIpaId, setSelectedIpaId] = useState<string | null>(null);

  const [apks, setApks] = useState<APK[]>([]);
  const [selectedApkId, setSelectedApkId] = useState<string | null>(null);

  const refreshIpas = useCallback(() => {
    listIpas().then(setIpas).catch(console.error);
  }, []);

  const refreshApks = useCallback(() => {
    listApks().then(setApks).catch(console.error);
  }, []);

  useEffect(() => {
    refreshIpas();
    refreshApks();
  }, [refreshIpas, refreshApks]);

  function changePlatform(next: Platform) {
    setPlatform(next);
    try {
      localStorage.setItem(PLATFORM_STORAGE_KEY, next);
    } catch {
      // best-effort; per-viewer convenience only
    }
    // "dynamic"/"docs" don't exist on the Android side yet
    if (next === "android" && (view === "dynamic" || view === "docs")) {
      setView("workbench");
    }
  }

  const selectedIpa = ipas.find((i) => i.id === selectedIpaId) ?? null;
  const selectedApk = apks.find((a) => a.id === selectedApkId) ?? null;

  return (
    <div className="shell">
      <NavRail view={view} onChange={setView} platform={platform} />

      <div className="frame">
        <div className="platform-bar">
          <PlatformSwitch platform={platform} onChange={changePlatform} />
        </div>

        <div className="topbar">
          {platform === "ios" && view === "workbench" && selectedIpa ? (
            <div className="breadcrumb">
              <span className="section">Workbench</span>
              <span className="sep">/</span>
              <span className="scan mono">{selectedIpa.original_filename}</span>
              <span className={`pill pill-${selectedIpa.status}`}>{selectedIpa.status}</span>
            </div>
          ) : platform === "android" && view === "workbench" && selectedApk ? (
            <div className="breadcrumb">
              <span className="section">Workbench</span>
              <span className="sep">/</span>
              <span className="scan mono">{selectedApk.app_name || selectedApk.package_name || selectedApk.original_filename}</span>
              <span className={`pill pill-${selectedApk.status}`}>{selectedApk.status}</span>
            </div>
          ) : (
            <div className="breadcrumb">
              <span className="section">{SECTION_TITLE[view]}</span>
            </div>
          )}
        </div>

        <div className="body">
          {platform === "ios" && view === "workbench" && (
            <WorkbenchPage
              ipas={ipas}
              selectedIpaId={selectedIpaId}
              onSelectIpa={setSelectedIpaId}
              onIpasChanged={refreshIpas}
            />
          )}
          {platform === "ios" && view === "compare" && (
            <ComparePage
              ipas={ipas}
              onJumpToScan={(id) => {
                setSelectedIpaId(id);
                setView("workbench");
              }}
            />
          )}
          {platform === "ios" && view === "dynamic" && <DynamicPage ipas={ipas} />}
          {platform === "ios" && view === "docs" && <McpDocsPage />}

          {platform === "android" && view === "workbench" && (
            <AndroidWorkbenchPage
              apks={apks}
              selectedApkId={selectedApkId}
              onSelectApk={setSelectedApkId}
              onApksChanged={refreshApks}
            />
          )}
          {platform === "android" && view === "compare" && (
            <AndroidComparePage
              apks={apks}
              onJumpToScan={(id) => {
                setSelectedApkId(id);
                setView("workbench");
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
