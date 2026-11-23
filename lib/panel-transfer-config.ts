import type { PanelTransferAccess } from "./panel-transfer-command.ts";
import { createPanelTransferReceiver, createPanelTransferSource, panelTransferOrigin } from "./panel-transfer.ts";

function level(value: unknown) {
  return value === 0 || value === 1 || value === 2 ? value : 3;
}

export function configurePanelTransfer(value: unknown, signal: AbortSignal): PanelTransferAccess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const config = value as Record<string, unknown>;
  const { publicOrigin, peers } = config;
  const exportLevel = level(config.export), importLevel = level(config.import);
  if (exportLevel === 3 && importLevel === 3) return;
  const origin = exportLevel !== 3 && typeof publicOrigin === "string" ? panelTransferOrigin(publicOrigin) : undefined;
  const trusted = importLevel !== 3 && Array.isArray(peers) && peers.length <= 32
    ? peers.filter((peer): peer is string => typeof peer === "string").map(panelTransferOrigin)
      .filter((peer): peer is string => peer !== undefined) : [];
  return {
    source: createPanelTransferSource({ publicOrigin: origin, signal }),
    receive: createPanelTransferReceiver({ peers: [...new Set(trusted)] }),
    exportLevel, importLevel,
  };
}
