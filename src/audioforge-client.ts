import { exec, spawn } from "child_process";
import streamDeck from "@elgato/streamdeck";
import WebSocket from "ws";
import type {
  AudioForgeCatalog,
  AudioForgeState,
  CommandPayload,
  GlobalSettings,
  SavedStateInfo,
  SavedStatesList,
  WsMessage,
} from "./types";

type StateListener = (state: AudioForgeState) => void;
type CatalogListener = (catalog: AudioForgeCatalog) => void;
type ConnectionListener = (connected: boolean) => void;
type SavedStatesListener = (states: SavedStateInfo[]) => void;

/**
 * Singleton WebSocket client that maintains a persistent connection to the
 * AudioForge Local API. All Stream Deck actions share this one connection.
 */
class AudioForgeClient {
  private ws: WebSocket | null = null;
  private _state: AudioForgeState | null = null;
  private _catalog: AudioForgeCatalog | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private port = 8329;
  private host = "localhost";
  private apiKey = "";
  private _connected = false;
  private started = false;

  private pending = new Map<string, { resolve: (m: WsMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private requestSeq = 0;

  private _savedStates: SavedStateInfo[] = [];
  private stateListeners: StateListener[] = [];
  private catalogListeners: CatalogListener[] = [];
  private connectionListeners: ConnectionListener[] = [];
  private savedStatesListeners: SavedStatesListener[] = [];

  get isConnected(): boolean {
    return this._connected;
  }
  get state(): AudioForgeState | null {
    return this._state;
  }
  get catalog(): AudioForgeCatalog | null {
    return this._catalog;
  }
  get savedStates(): SavedStateInfo[] {
    return this._savedStates;
  }

  /** HTTP base URL for REST calls (icon fetch, etc.). */
  get httpBaseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** URL query string for authenticated HTTP requests (empty if no key). */
  get httpAuthQuery(): string {
    return this.apiKey ? `&apiKey=${encodeURIComponent(this.apiKey)}` : "";
  }

  onState(fn: StateListener) {
    this.stateListeners.push(fn);
  }
  offState(fn: StateListener) {
    this.stateListeners = this.stateListeners.filter((f) => f !== fn);
  }

  onCatalog(fn: CatalogListener) {
    this.catalogListeners.push(fn);
  }
  offCatalog(fn: CatalogListener) {
    this.catalogListeners = this.catalogListeners.filter((f) => f !== fn);
  }

  onConnection(fn: ConnectionListener) {
    this.connectionListeners.push(fn);
  }
  offConnection(fn: ConnectionListener) {
    this.connectionListeners = this.connectionListeners.filter((f) => f !== fn);
  }

  onSavedStates(fn: SavedStatesListener) {
    this.savedStatesListeners.push(fn);
  }
  offSavedStates(fn: SavedStatesListener) {
    this.savedStatesListeners = this.savedStatesListeners.filter((f) => f !== fn);
  }

  /** Apply settings and connect. */
  async startWithSettings(settings: GlobalSettings) {
    this.host = settings.host || "localhost";
    this.port = settings.port || 8329;
    this.apiKey = settings.apiKey || "";
    this.started = true;
    this.connect();
  }

  /** Update connection config and reconnect. */
  async updateSettings(settings: GlobalSettings) {
    const newHost = settings.host || "localhost";
    const changed = settings.port !== this.port || settings.apiKey !== this.apiKey || newHost !== this.host;
    this.host = newHost;
    this.port = settings.port || 8329;
    this.apiKey = settings.apiKey || "";
    if (changed && this.started) {
      this.reconnectDelay = 1000;
      this.connect();
    }
  }

  /** Send a command to AudioForge. */
  send(cmd: CommandPayload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    } else {
      // User triggered an action but AudioForge isn't connected — try to open it.
      this.tryLaunchAudioForge();
    }
  }

  /**
   * Send a command and resolve with Audio Forge's result message (which carries extra fields for some
   * commands, such as durationMs for playEcho). Rejects when offline, on an error result, or on timeout.
   */
  request(cmd: CommandPayload, timeoutMs = 12_000): Promise<WsMessage> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.tryLaunchAudioForge();
      return Promise.reject(new Error("Audio Forge is not connected"));
    }
    const requestId = `sd-${++this.requestSeq}`;
    return new Promise<WsMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`No answer to "${cmd.command}" in time`));
      }, timeoutMs);
      // Do not keep the plugin process alive for a pending request.
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...cmd, requestId }));
    });
  }

  private rejectPending(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  /**
   * Call this at the top of every physical key/dial handler so that pressing
   * any button while offline triggers the AudioForge launch, even for actions
   * that would otherwise return early (e.g. not yet configured).
   */
  launchIfOffline() {
    if (!this._connected) this.tryLaunchAudioForge();
  }

  private redactApiKey(value: unknown): string {
    let message = value instanceof Error ? value.message : String(value);
    if (!this.apiKey) return message;
    for (const secret of new Set([this.apiKey, encodeURIComponent(this.apiKey)])) {
      if (secret) message = message.split(secret).join("[redacted]");
    }
    return message;
  }

  private connect() {
    this.disconnect();
    const url = `ws://${this.host}:${this.port}/ws${this.apiKey ? `?apiKey=${encodeURIComponent(this.apiKey)}` : ""}`;
    // The API key is part of the WebSocket query string. Keep it out of logs.
    streamDeck.logger.info(`Connecting to AudioForge at ws://${this.host}:${this.port}/ws`);

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      streamDeck.logger.error(`WebSocket creation failed: ${this.redactApiKey(e)}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      streamDeck.logger.info("Connected to AudioForge");
      this._connected = true;
      this.reconnectDelay = 1000;
      // unref the underlying TCP socket so it doesn't block process exit
      (this.ws as any)?._socket?.unref();
      this.notify(this.connectionListeners, true);
      this.fetchSavedStates();
    });

    this.ws.on("message", (raw: WebSocket.Data) => {
      try {
        const msg: WsMessage = JSON.parse(raw.toString());
        this.handleMessage(msg);
      } catch (e) {
        streamDeck.logger.error(`Parse error: ${e}`);
      }
    });

    this.ws.on("close", () => {
      streamDeck.logger.info("Disconnected from AudioForge");
      this._connected = false;
      this.rejectPending(new Error("Audio Forge connection closed"));
      this.notify(this.connectionListeners, false);
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      streamDeck.logger.error(`WebSocket error: ${this.redactApiKey(err)}`);
    });
  }

  private disconnect() {
    this.rejectPending(new Error("Audio Forge connection closed"));
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    if (this._connected) {
      this._connected = false;
      this.notify(this.connectionListeners, false);
    }
  }

  /**
   * Forcefully tear down the WebSocket and all timers so the Node.js event
   * loop can drain and the process can exit (e.g. during plugin uninstall).
   * Uses ws.terminate() instead of ws.close() to destroy the socket
   * immediately without waiting for a close handshake.
   */
  shutdown() {
    this.started = false;
    this.rejectPending(new Error("Audio Forge client shut down"));
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch (_) {}
      this.ws = null;
    }
    this._connected = false;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    streamDeck.logger.info(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect();
    }, this.reconnectDelay);
    // unref so this timer doesn't prevent the process from exiting
    // (e.g. when Stream Deck uninstalls the plugin while AudioForge is running)
    this.reconnectTimer.unref();
  }

  private _lastLaunchMs = 0;
  private readonly LAUNCH_COOLDOWN_MS = 10_000;

  private tryLaunchAudioForge() {
    const now = Date.now();
    if (now - this._lastLaunchMs < this.LAUNCH_COOLDOWN_MS) return;
    this._lastLaunchMs = now;

    const open = (url: string) => {
      // Use spawn with detached+unref so the child process is fully detached
      // from this Node.js process and cannot prevent it from exiting.
      const [cmd, args] =
        process.platform === "win32"  ? ["cmd.exe", ["/c", "start", "\"\"", url]] :
        process.platform === "darwin" ? ["open",    [url]] :
                                        ["xdg-open",[url]];
      const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
      child.on("error", (err) => {
        streamDeck.logger.warn(`Could not open ${url}: ${err.message}`);
      });
      child.unref();
    };

    if (process.platform === "win32") {
      exec('reg query "HKCR\\audioforge"', (err) => {
        if (err) {
          streamDeck.logger.info("audioforge:// not registered — opening download page");
          open("https://slashpaf.com/audioforge/download");
        } else {
          streamDeck.logger.info("Launching Audio Forge via audioforge://");
          open("audioforge://");
        }
      });
    } else {
      // On macOS/Linux open returns non-zero if scheme not registered.
      let fallbackLaunched = false;
      const openDownloadPage = () => {
        if (fallbackLaunched) return;
        fallbackLaunched = true;
        streamDeck.logger.info("audioforge:// not registered — opening download page");
        open("https://slashpaf.com/audioforge/download");
      };
      const child = spawn(
        process.platform === "darwin" ? "open" : "xdg-open",
        ["audioforge://"],
        { stdio: "ignore" },
      );
      child.on("error", (err) => {
        streamDeck.logger.info(`Could not launch audioforge://: ${err.message}`);
        openDownloadPage();
      });
      child.on("close", (code) => {
        if (code !== 0) openDownloadPage();
      });
    }
  }

  async fetchSavedStates(): Promise<void> {
    try {
      const url = `${this.httpBaseUrl}/api/saved_states${this.apiKey ? `?apiKey=${encodeURIComponent(this.apiKey)}` : ""}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json() as SavedStatesList;
      this._savedStates = data.savedStates ?? [];
      this.notify(this.savedStatesListeners, this._savedStates);
    } catch (_) {}
  }

  /** Call listeners without letting a throwing or rejecting one take down the plugin process. */
  private notify<T>(listeners: Array<(arg: T) => unknown>, arg: T) {
    for (const fn of listeners) {
      try {
        Promise.resolve(fn(arg)).catch((e) => streamDeck.logger.error(`Listener error: ${e}`));
      } catch (e) {
        streamDeck.logger.error(`Listener error: ${e}`);
      }
    }
  }

  private handleMessage(msg: WsMessage) {
    switch (msg.type) {
      case "state":
        this._state = msg as unknown as AudioForgeState;
        this.notify(this.stateListeners, this._state!);
        break;
      case "catalog":
        this._catalog = msg as unknown as AudioForgeCatalog;
        this.notify(this.catalogListeners, this._catalog!);
        break;
      case "saved_states":
        this._savedStates = (msg as unknown as SavedStatesList).savedStates ?? [];
        this.notify(this.savedStatesListeners, this._savedStates);
        break;
      case "result": {
        const requestId = typeof msg.requestId === "string" ? msg.requestId : null;
        const p = requestId ? this.pending.get(requestId) : undefined;
        if (!p || !requestId) break; // Results of plain send() calls are not tracked.
        this.pending.delete(requestId);
        clearTimeout(p.timer);
        if (msg.ok === false) p.reject(new Error(String(msg.error ?? "Audio Forge command failed")));
        else p.resolve(msg);
        break;
      }
      case "echo":
        // Could flash an echo button
        break;
    }
  }
}

// Singleton instance
export const audioForge = new AudioForgeClient();
