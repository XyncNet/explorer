// Клиент api-сервиса валидатора (тонкий шлюз xync/api/service.py) + WebSocket
// событий. База — префикс dev-прокси (/n1../n4) или полный URL прод-ноды.

import type {Currencies} from "./format";

export interface TxRec {
  tx_id: string;
  from: number;
  to: number;
  currency: number;
  amount: number;
  fee?: number;
  fee_level?: number;
  seq: number;
  settled_ms?: number;
  commit_round?: number | null;
  commit_ms?: number;
  kind?: string; // "swap" | "pool_out" | "pool_add" | "pool_refund" | "pool_swap" | …
  pair_id?: string;
  peer_currency?: number;
  peer_amount?: number;
}

export interface StatusResp {
  validator: number;
  ts: number;
  chain: string;
  state: {
    committed_rounds: number;
    checkpoint: Checkpoint | null;
    accounts: number;
    fee_pool: number;
    settled: number;
    rejected: number;
    registered: number;
    burned?: number;
    banned?: number;
  };
  consensus: {round: number; decided_round: number; dag_blocks: number; queue_certs: number; queue_sys: number};
  mempool: {
    ok: boolean;
    accept_free: boolean;
    pending: number;
    pending_swaps: number;
    parked: number;
    frozen: number[];
    requests: number;
    intents: number;
    proposals: number;
  };
  p2p: unknown;
}

export interface Checkpoint {
  round: number;
  root: string;
  ts: number;
  accounts: number;
  settled: number;
  issuer_events?: unknown[];
}

export interface Account {
  index: number;
  pubkey: string;
  seq: number;
  next_seq: number;
  free_left: number;
  banned: boolean;
  balances: Record<string, number>;
  available: Record<string, number>;
  error?: string;
}

export interface Pool {
  pid: number;
  cur_a: number;
  cur_b: number;
  ra: number;
  rb: number;
  total_shares: number;
  fee_bps: number;
  acct: number;
  creator?: number;
  cmd?: string;
  spot_a_in_b: number;
  spot_b_in_a: number;
}

export interface Intent {
  intent_id: string;
  maker: number;
  give: number;
  want: number;
  fixed: "give" | "want";
  amount: number;
  limit: number;
  deadline: number;
  ts: number;
}

export interface MoneyReq {
  req_id: string;
  payer: number;
  requester: number;
  cur: number;
  amount: number;
  ts: number;
}

export interface Validators {
  version: number;
  quorum: number;
  validators: Record<string, {account: number; pubkey: string; p2p_url?: string}>;
}

export interface AccountBrief {
  index: number;
  pubkey: string;
  seq: number;
  banned: boolean;
  balances: Record<string, number>;
}

export interface PendingTx {
  tx_id: string;
  from: number;
  to: number;
  currency: number;
  amount: number;
  seq: number;
  fee_level: number;
  local: boolean;
  age_ms: number;
}

export interface PendingSwap {
  pair_id: string;
  a: number;
  b: number;
  cur_a: number;
  amount_a: number;
  cur_b: number;
  amount_b: number;
  age_ms: number;
}

export interface MempoolResp {
  pending: PendingTx[];
  pending_swaps: PendingSwap[];
  parked: number;
  frozen: number[];
  requests: number;
  intents: number;
}

export class NodeApi {
  constructor(public base: string) {}

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(this.base + path, {headers: {accept: "application/json"}});
    const text = await r.text();
    if (!r.ok && r.status !== 404) throw new Error(`GET ${path} → ${r.status}`);
    // 404 с JSON-телом (напр. {"error":…} у /account, /pool, /tx) — валидно,
    // вызывающий проверит .error. 404 без JSON = маршрута нет (старая нода).
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        r.status === 404
          ? `эндпоинт ${path} недоступен — перезапустите ноду (добавлены новые маршруты)`
          : `${path}: ответ не JSON (${text.slice(0, 50)})`
      );
    }
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(this.base + path, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body),
    });
    const data = (await r.json().catch(() => ({}))) as T;
    return data;
  }

  status = () => this.get<StatusResp>("/status");
  recent = () => this.get<TxRec[]>("/recent");
  checkpoints = () => this.get<Checkpoint[]>("/checkpoints");
  accounts = () => this.get<AccountBrief[]>("/accounts");
  mempool = () => this.get<MempoolResp>("/mempool");
  txById = (id: string) => this.get<TxRec & {error?: string}>(`/tx/${id}`);
  currencies = async (): Promise<Currencies> => {
    const raw = await this.get<Record<string, {name: string; scale: number; issuer_acct?: number; rate_bps?: number}>>("/currencies");
    const out: Currencies = {};
    for (const [k, v] of Object.entries(raw)) out[Number(k)] = v;
    return out;
  };
  validators = () => this.get<Validators>("/validators");
  account = (idx: number) => this.get<Account>(`/account/${idx}`);
  accountByPub = (pub: string) => this.get<{index?: number; error?: string}>(`/account_by_pub/${pub}`);
  history = (idx: number, limit = 50) => this.get<TxRec[]>(`/history/${idx}?limit=${limit}`);
  pools = () => this.get<Pool[]>("/pools");
  pool = (pid: number) => this.get<Pool>(`/pool/${pid}`);
  lp = (acct: number) => this.get<{acct: number; positions: {pid: number; shares: number}[]}>(`/lp/${acct}`);
  stakes = (acct: number) =>
    this.get<{acct: number; issuer: {cur: number; amount: number}[]; lp: {pid: number; shares: number}[]}>(`/stakes/${acct}`);
  intents = (q = "") => this.get<Intent[]>("/intents" + (q ? `?${q}` : ""));
  requestsFor = (idx: number) => this.get<MoneyReq[]>(`/requests/${idx}`);
  proposalsFor = (idx: number) => this.get<{intent_id: string; half: string; intent: Intent}[]>(`/proposals/${idx}`);
}

/** Подписка на события ноды. Возвращает функцию отписки. */
export function subscribeEvents(base: string, onEvent: (ev: any) => void, acct?: number): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: number | undefined;
  const url = () => {
    const abs = new URL(base + "/events" + (acct != null ? `?acct=${acct}` : ""), location.href);
    abs.protocol = abs.protocol === "https:" ? "wss:" : "ws:";
    return abs.toString();
  };
  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(url());
      ws.onmessage = (m) => {
        try {
          onEvent(JSON.parse(m.data));
        } catch {
          /* игнор мусора */
        }
      };
      ws.onclose = () => {
        if (!closed) timer = window.setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    } catch {
      timer = window.setTimeout(connect, 2000);
    }
  };
  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
