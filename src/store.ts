// Глобальное состояние обозревателя: выбранная нода, реестр валют, последний
// статус, набор валидаторов, накопленная история чекпоинтов (нода отдаёт только
// последний — копим на клиенте из поллинга статуса и commit-событий), кошелёк.

import {NodeApi, subscribeEvents, type StatusResp, type Validators, type Checkpoint} from "./api";
import type {Currencies} from "./format";
import type {WalletSession} from "./wallet";

export interface NodeCfg {
  id: string; // "n1"
  label: string; // "Валидатор 1"
}

export const NODES: NodeCfg[] = [
  {id: "n1", label: "Валидатор 1"},
  {id: "n2", label: "Валидатор 2"},
  {id: "n3", label: "Валидатор 3"},
  {id: "n4", label: "Валидатор 4"},
];

// База API ноды. В DEV — путь vite-прокси (/n1../n4, обходит CORS). В PROD
// (напр. GitHub Pages, прокси нет) — прямой URL ноды из env VITE_N1..N4;
// CORS на ноде уже включён. VITE_NODE — общий дефолт для всех.
function nodeBase(id: string): string {
  if (import.meta.env.DEV) return "/" + id;
  const prod: Record<string, string | undefined> = {
    n1: import.meta.env.VITE_N1,
    n2: import.meta.env.VITE_N2,
    n3: import.meta.env.VITE_N3,
    n4: import.meta.env.VITE_N4,
  };
  return prod[id] || import.meta.env.VITE_NODE || "https://api.xync.net";
}

type Listener = () => void;

class Store {
  nodeId = localStorage.getItem("xync.node") || "n1";
  api = new NodeApi(this.baseOf(this.nodeId));
  currencies: Currencies = {};
  status: StatusResp | null = null;
  validators: Validators | null = null;
  checkpoints = new Map<number, Checkpoint>();
  wallet: WalletSession | null = null;
  eventLog: any[] = [];
  lastError = "";

  private listeners = new Set<Listener>();
  private unsub: (() => void) | null = null;

  baseOf(id: string): string {
    return nodeBase(id);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    for (const fn of this.listeners) fn();
  }

  async setNode(id: string): Promise<void> {
    this.nodeId = id;
    localStorage.setItem("xync.node", id);
    this.api = new NodeApi(this.baseOf(id));
    this.checkpoints = new Map();
    this.loadCheckpointCache();
    await this.refreshMeta();
    this.startEvents();
    this.emit();
  }

  /** Валюты + набор валидаторов (меняются редко). */
  async refreshMeta(): Promise<void> {
    try {
      [this.currencies, this.validators] = await Promise.all([this.api.currencies(), this.api.validators()]);
    } catch (e) {
      this.lastError = String(e);
    }
  }

  async refreshStatus(): Promise<void> {
    try {
      this.status = await this.api.status();
      this.lastError = "";
      const cp = this.status.state?.checkpoint;
      if (cp) this.rememberCheckpoint(cp);
    } catch (e) {
      this.lastError = String(e);
    }
    // НАМЕРЕННО без emit(): обновление статуса не должно триггерить подписчиков.
    // Иначе panelDashboard/panelFraud → refreshStatus → emit → renderMain →
    // снова refreshStatus → … зацикливалось (запросы /status «каждые 0 сек»).
    // Поллинг статуса — единым таймером в main (раз в 5 с).
  }

  rememberCheckpoint(cp: Checkpoint): void {
    if (cp && typeof cp.round === "number" && !this.checkpoints.has(cp.round)) {
      this.checkpoints.set(cp.round, cp);
      this.saveCheckpointCache();
    }
  }

  private ckKey(): string {
    return `xync.ck.${this.nodeId}`;
  }
  private loadCheckpointCache(): void {
    try {
      const raw = JSON.parse(localStorage.getItem(this.ckKey()) || "[]") as Checkpoint[];
      for (const cp of raw) this.checkpoints.set(cp.round, cp);
    } catch {
      /* пусто */
    }
  }
  private saveCheckpointCache(): void {
    const arr = [...this.checkpoints.values()].sort((a, b) => b.round - a.round).slice(0, 100);
    localStorage.setItem(this.ckKey(), JSON.stringify(arr));
  }

  startEvents(): void {
    this.unsub?.();
    this.unsub = subscribeEvents(this.baseOf(this.nodeId), (ev) => {
      this.eventLog.unshift({...ev, _rx: Date.now()});
      if (this.eventLog.length > 200) this.eventLog.pop();
      if (ev.type === "commit" && ev.checkpoint) this.rememberCheckpoint(ev.checkpoint);
      this.emit();
    });
  }

  async init(): Promise<void> {
    this.loadCheckpointCache();
    await this.refreshMeta();
    await this.refreshStatus();
    this.startEvents();
  }
}

export const store = new Store();
