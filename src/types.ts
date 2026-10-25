// Shared types matching the AudioForge Local API payloads

import type { JsonValue } from "@elgato/utils";

export interface CategoryInfo {
  uuid: string;
  name: string;
  color?: string;
  oneShot?: boolean;
  enabledInForge?: boolean;
  trackCount?: number;
  volume?: number; // 0-1 display scale
}

export interface AudioForgeState {
  musicPlaying: boolean;
  ambiancePlaying: boolean;
  musicVolume: number;
  ambianceVolume: number;
  echoesVolume: number;
  musicCategories: CategoryInfo[];
  ambianceCategories: CategoryInfo[];
  libraryUuid: string;
  libraryName: string;
  categoryVolume: Record<string, number>; // 0-1 display scale
}

export interface CatalogLibrary {
  uuid: string;
  name: string;
  music: CategoryInfo[];
  ambiance: CategoryInfo[];
}

export interface AudioForgeCatalog {
  activeLibraryUuid: string;
  libraries: CatalogLibrary[];
}

export interface CommandPayload {
  command: string;
  section?: string;
  categoryUuid?: string;
  categoryName?: string;
  libraryUuid?: string;
  libraryName?: string;
  value?: number;
  transitionMs?: number;
  enabled?: boolean;
  key?: string;
  requestId?: string;
  [key: string]: JsonValue;
}

export interface CommandResult {
  type: "result";
  ok: boolean;
  message?: string;
  error?: string;
  requestId?: string;
}

export interface WsMessage {
  type: "state" | "catalog" | "result" | "echo" | "echoes" | "saved_states";
  [key: string]: JsonValue;
}

export interface SavedStateInfo {
  id: string;
  name: string;
  group: string | null;
  libraryUuid: string | null;
  libraryName: string;
  createdAt: string;
  stateLink: string;
}

export interface SavedStatesList {
  savedStates: SavedStateInfo[];
}

export interface SavedStateSettings {
  stateId: string;
  stateName: string;
  iconData: string;
  [key: string]: JsonValue;
}

// Settings stored per-action instance
export interface PlayPauseSettings {
  section: string; // "Music" or "Ambiance"
  [key: string]: JsonValue;
}

export interface StopSettings {
  section: string;
  [key: string]: JsonValue;
}

export interface NextTrackSettings {
  section: string; // "Music" or "Ambiance"
  [key: string]: JsonValue;
}

export interface CategorySettings {
  section: string;
  categoryUuid: string;
  categoryName: string;
  iconData: string;
  [key: string]: JsonValue;
}

export interface EchoSettings {
  categoryUuid: string;
  categoryName: string;
  iconData: string;
  [key: string]: JsonValue;
}

export interface VolumeSettings {
  section: string;
  categoryUuid?: string; // optional: control one category instead of the whole section
  categoryName?: string;
  value: number; // 0-100 for keypad preset
  step: number;  // increment for dial
  [key: string]: JsonValue;
}

export interface LibrarySettings {
  libraryUuid: string;
  libraryName: string;
  [key: string]: JsonValue;
}

// Global settings shared across all actions
export interface GlobalSettings {
  host: string;
  port: number;
  apiKey: string;
  [key: string]: JsonValue;
}

/** One entry of the `echoes` message: an echo that is playing right now, however it was started. */
export interface ActiveEcho {
  playbackId: string;
  categoryUuid: string;
  durationMs: number | null;
  positionMs: number | null;
  remainingMs: number | null;
}
