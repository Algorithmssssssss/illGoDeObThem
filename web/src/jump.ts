// Where a Compare-page "A ↗" / "B ↗" button should land inside that scan's
// Workbench. Items are identified by what the diff knows about them (a path
// or a name); the Workbench resolves that against the scan's own data.
export type WorkbenchTarget =
  | { kind: "file"; path: string }
  | { kind: "class"; name: string }
  | { kind: "function"; name: string };

// Which two scans the Compare page has picked. Owned by App so the pick
// survives a jump into the Workbench and back.
export interface CompareSelection {
  a: string;
  b: string;
}

export interface PendingJump {
  scanId: string;
  target: WorkbenchTarget;
}
