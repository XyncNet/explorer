// Кошелёк обозревателя. Провайдер-абстракция отделяет ПОДПИСЬ от построения
// операций: ключ никогда не покидает провайдер (правило кошелька Xync §1).
//
//   • LocalKeyProvider  — сид импортируется в браузер, подпись локально.
//   • XyncConnectProvider — «подключить внешний кошелёк» (xma mini-app) по схеме
//     TON Connect: провайдер шлёт запрос на подпись в окно кошелька и ждёт байты.
//
// Операции ниже строят тела/команды через codec.ts и шлют их на api-ноду.

import * as C from "./codec";
import {NodeApi, type Account, type Intent, type MoneyReq} from "./api";

export interface WalletProvider {
  readonly kind: "local" | "connect";
  readonly pubkey: string; // hex ed25519
  sign(domain: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
}

export interface WalletSession {
  provider: WalletProvider;
  pubkey: string;
  index: number | null; // null — аккаунт ещё не зарегистрирован в сети
  label: string;
}

// ── LocalKeyProvider ─────────────────────────────────────────────────────────
export class LocalKeyProvider implements WalletProvider {
  readonly kind = "local" as const;
  readonly pubkey: string;
  constructor(private seed: Uint8Array) {
    this.pubkey = C.toHex(C.pubFromSeed(seed));
  }
  async sign(domain: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
    return C.sign(this.seed, domain, message);
  }
}

// ── XyncConnectProvider (мост к внешнему кошельку) ────────────────────────────
// Протокол (postMessage / инъекция window.xyncWallet):
//   запрос:  {xync:"sign", id, domain:"XYNC:TX:", message:"<hex>"}
//   ответ:   {xync:"signed", id, sig:"<hex 64>"}
// xma реализует приёмник в mini-app (см. explorer/README — раздел XyncConnect).
export interface InjectedWallet {
  pubkey: string;
  sign(domainHex: string, messageHex: string): Promise<string>;
}
declare global {
  interface Window {
    xyncWallet?: InjectedWallet;
  }
}

export class XyncConnectProvider implements WalletProvider {
  readonly kind = "connect" as const;
  constructor(private injected: InjectedWallet) {}
  get pubkey(): string {
    return this.injected.pubkey;
  }
  async sign(domain: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
    const sigHex = await this.injected.sign(C.toHex(domain), C.toHex(message));
    return C.fromHex(sigHex);
  }
}

// ── построение сессии ─────────────────────────────────────────────────────────
export async function resolveIndex(api: NodeApi, pubkey: string): Promise<number | null> {
  const r = await api.accountByPub(pubkey);
  return typeof r.index === "number" ? r.index : null;
}

export async function connectLocalSeed(api: NodeApi, seedHex: string, label = "Локальный ключ"): Promise<WalletSession> {
  const seed = C.fromHex(seedHex.trim());
  if (seed.length !== 32) throw new Error("сид приватного ключа должен быть 32 байта (64 hex)");
  const provider = new LocalKeyProvider(seed);
  const index = await resolveIndex(api, provider.pubkey);
  return {provider, pubkey: provider.pubkey, index, label};
}

/** Импорт из файла кошелька Xync (wallets/*.json: {priv, pub, index}). */
export async function connectWalletJson(api: NodeApi, json: string): Promise<WalletSession> {
  const w = JSON.parse(json) as {priv?: string; pub?: string; index?: number};
  if (!w.priv) throw new Error("в JSON нет поля priv (сид ключа)");
  const s = await connectLocalSeed(api, w.priv, "Импорт JSON");
  if (w.index != null && s.index == null) s.index = w.index;
  return s;
}

// ── утилиты ────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Дождаться финализации (seq отправителя дорос до target). */
async function waitSeq(api: NodeApi, idx: number, target: number, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const a = await api.account(idx);
    if ((a.seq ?? 0) >= target) return true;
    await sleep(60);
  }
  return false;
}

async function freshAccount(api: NodeApi, idx: number): Promise<Account> {
  const a = await api.account(idx);
  if (a.error) throw new Error(`аккаунт #${idx}: ${a.error}`);
  return a;
}

export interface OpResult {
  ok: boolean;
  msg: string;
  detail?: any;
}

// ── регистрация аккаунта ───────────────────────────────────────────────────────
export async function register(api: NodeApi, s: WalletSession): Promise<OpResult> {
  const sig = await s.provider.sign(C.DOMAIN.REG, C.fromHex(s.pubkey));
  await api.post("/register", {pubkey: s.pubkey, sig: C.toHex(sig)});
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const idx = await resolveIndex(api, s.pubkey);
    if (idx != null) {
      s.index = idx;
      return {ok: true, msg: `Аккаунт зарегистрирован: #${idx}`};
    }
  }
  return {ok: false, msg: "Регистрация не подтверждена за 40 с (сеть простаивает?)"};
}

// ── перевод ─────────────────────────────────────────────────────────────────────
export async function send(
  api: NodeApi,
  s: WalletSession,
  to: number,
  currency: number,
  amount: bigint,
  feeLevel = 1
): Promise<OpResult> {
  if (s.index == null) throw new Error("аккаунт не зарегистрирован");
  const acc = await freshAccount(api, s.index);
  const body: C.TxBody = {currency, amount, seq: acc.next_seq, fee: feeLevel, to, frm: s.index};
  const id = C.packBody(body);
  const sig = await s.provider.sign(C.DOMAIN.TX, id);
  const hex = C.toHex(C.fromHex(C.toHex(id) + C.toHex(sig)));
  const res = await api.post<any>("/tx", {tx: hex});
  if (!res.ok) return {ok: false, msg: res.error || "нода отклонила перевод", detail: res};
  const fin = await waitSeq(api, s.index, body.seq);
  return {ok: true, msg: fin ? `Перевод финализирован (seq ${body.seq})` : "Отправлено, финализация не подтверждена за 12 с", detail: res};
}

// ── запросы денег ────────────────────────────────────────────────────────────────
export async function requestMoney(api: NodeApi, s: WalletSession, payer: number, currency: number, amount: bigint): Promise<OpResult> {
  if (s.index == null) throw new Error("аккаунт не зарегистрирован");
  const payload = {payer, requester: s.index, cur: currency, amount: Number(amount), ts: Date.now()};
  const reqId = C.toHex(C.sha256_16(C.canonicalJson(payload)));
  const sig = await s.provider.sign(C.DOMAIN.REQ, C.fromHex(reqId));
  const res = await api.post<any>("/request", {...payload, sig: C.toHex(sig)});
  if (!res.ok && res.error) return {ok: false, msg: res.error, detail: res};
  return {ok: true, msg: `Запрос создан: ${reqId.slice(0, 12)}…`, detail: res};
}

export async function rejectRequest(api: NodeApi, s: WalletSession, reqId: string): Promise<OpResult> {
  const msg = C.fromHex(reqId + C.toHex(new TextEncoder().encode(":reject")));
  const sig = await s.provider.sign(C.DOMAIN.REQ, msg);
  const res = await api.post<any>(`/request/${reqId}/reject`, {sig: C.toHex(sig)});
  return {ok: !!res.ok, msg: res.ok ? "Запрос отклонён" : res.error || "ошибка", detail: res};
}

/** Одобрить (оплатить) запрос: обычный перевод requester'у гасит запрос. */
export async function approveRequest(api: NodeApi, s: WalletSession, req: MoneyReq): Promise<OpResult> {
  return send(api, s, req.requester, req.cur, BigInt(req.amount), 1);
}

// ── P2P-своп (полу-своп → приём) ────────────────────────────────────────────────
export async function swapPropose(
  api: NodeApi,
  s: WalletSession,
  peer: number,
  giveCur: number,
  giveAmt: bigint,
  takeCur: number,
  takeAmt: bigint,
  feeLevel = 1
): Promise<{half: string}> {
  if (s.index == null) throw new Error("аккаунт не зарегистрирован");
  const me = await freshAccount(api, s.index);
  const peerAcc = await freshAccount(api, peer);
  const bodyA: C.TxBody = {currency: giveCur, amount: giveAmt, seq: me.next_seq, fee: feeLevel, to: peer, frm: s.index};
  const bodyB: C.TxBody = {currency: takeCur, amount: takeAmt, seq: peerAcc.next_seq, fee: feeLevel, to: s.index, frm: peer};
  const sigA = await s.provider.sign(C.DOMAIN.SWP, C.swapPairMsg(bodyA, bodyB));
  const half = C.fullSwapHex(bodyA, bodyB, sigA, new Uint8Array(64)).slice(0, (2 * C.TX_SIZE + C.SIG_SIZE) * 2);
  return {half};
}

export async function swapAccept(api: NodeApi, s: WalletSession, halfHex: string): Promise<OpResult> {
  if (s.index == null) throw new Error("аккаунт не зарегистрирован");
  const {a, b, sigA} = C.parseHalfSwap(halfHex);
  if (b.frm !== s.index) return {ok: false, msg: `полу-своп не для меня (моя нога from=${b.frm}, я #${s.index})`};
  const me = await freshAccount(api, s.index);
  if (b.seq !== me.next_seq) return {ok: false, msg: `мой seq устарел (в полу-свопе ${b.seq}, сейчас ${me.next_seq}) — попросите пере-предложить`};
  const sigB = await s.provider.sign(C.DOMAIN.SWP, C.swapPairMsg(a, b));
  const swapHex = C.fullSwapHex(a, b, sigA, sigB);
  const res = await api.post<any>("/swap", {swap: swapHex});
  if (!res.ok) return {ok: false, msg: res.error || "своп отклонён", detail: res};
  const fin = await waitSeq(api, s.index, b.seq);
  return {ok: true, msg: fin ? "Своп финализирован" : "Отправлено, финализация не подтверждена", detail: res};
}

// ── обменные интенты ─────────────────────────────────────────────────────────────
export async function intentNew(
  api: NodeApi,
  s: WalletSession,
  giveCur: number,
  wantCur: number,
  fixed: "give" | "want",
  amount: bigint,
  limitRate: bigint,
  ttlSec: number
): Promise<OpResult> {
  if (s.index == null) throw new Error("аккаунт не зарегистрирован");
  const now = Date.now();
  const payload = {
    maker: s.index,
    give: giveCur,
    want: wantCur,
    fixed,
    amount: Number(amount),
    limit: Number(limitRate),
    deadline: now + ttlSec * 1000,
    ts: now,
  };
  const iid = C.toHex(C.sha256_16(C.canonicalJson(payload)));
  const sig = await s.provider.sign(C.DOMAIN.XIN, C.fromHex(iid));
  const res = await api.post<any>("/intent", {...payload, sig: C.toHex(sig)});
  if (!res.ok) return {ok: false, msg: res.error || "интент отклонён", detail: res};
  return {ok: true, msg: `Интент опубликован: ${iid.slice(0, 12)}…`, detail: res};
}

export async function intentCancel(api: NodeApi, s: WalletSession, iid: string): Promise<OpResult> {
  const msg = C.fromHex(iid + C.toHex(new TextEncoder().encode(":gone")));
  const sig = await s.provider.sign(C.DOMAIN.XIN, msg);
  const res = await api.post<any>(`/intent/${iid}/gone`, {sig: C.toHex(sig)});
  return {ok: !!res.ok, msg: res.ok ? "Интент снят" : res.error || "ошибка", detail: res};
}

/** Взять интент: построить встречный полу-своп и отправить maker'у как proposal. */
export async function intentTake(api: NodeApi, s: WalletSession, it: Intent, feeLevel = 1): Promise<OpResult> {
  if (s.index == null) throw new Error("аккаунт не зарегистрирован");
  const {give, want} = counterAmounts(it);
  if (give < 1n || want < 1n) return {ok: false, msg: "интент неисполним: сумма округляется в 0"};
  const me = await freshAccount(api, s.index);
  const maker = await freshAccount(api, it.maker);
  // body_a — моя нога (отдаю want_cur maker'у); body_b — нога maker'а (give_cur мне)
  const bodyA: C.TxBody = {currency: it.want, amount: want, seq: me.next_seq, fee: feeLevel, to: it.maker, frm: s.index};
  const bodyB: C.TxBody = {currency: it.give, amount: give, seq: maker.next_seq, fee: feeLevel, to: s.index, frm: it.maker};
  const sigA = await s.provider.sign(C.DOMAIN.SWP, C.swapPairMsg(bodyA, bodyB));
  const half = C.fullSwapHex(bodyA, bodyB, sigA, new Uint8Array(64)).slice(0, (2 * C.TX_SIZE + C.SIG_SIZE) * 2);
  const res = await api.post<any>("/proposal", {intent_id: it.intent_id, half});
  if (!res.ok) return {ok: false, msg: res.error || "предложение отклонено", detail: res};
  return {ok: true, msg: "Предложение отправлено maker'у (ждёт его авто-подписи)", detail: res};
}

/** Встречные суммы интента ровно по limit_rate (округление в невыгоду taker'а). */
export function counterAmounts(it: Intent): {give: bigint; want: bigint} {
  const limit = BigInt(it.limit);
  const amount = BigInt(it.amount);
  if (it.fixed === "give") {
    const give = amount;
    const want = (give * limit + (C.RATE_SCALE - 1n)) / C.RATE_SCALE; // ceil
    return {give, want};
  }
  const want = amount;
  const give = (want * C.RATE_SCALE) / limit; // floor
  return {give, want};
}

// ── пулы ликвидности (deposit-then-command) ──────────────────────────────────────
async function depositToPool(api: NodeApi, s: WalletSession, poolAcct: number, currency: number, amount: bigint): Promise<string> {
  if (s.index == null) throw new Error("аккаунт не зарегистрирован");
  const acc = await freshAccount(api, s.index);
  const body: C.TxBody = {currency, amount, seq: acc.next_seq, fee: 1, to: poolAcct, frm: s.index};
  const id = C.packBody(body);
  const sig = await s.provider.sign(C.DOMAIN.TX, id);
  const res = await api.post<any>("/tx", {tx: C.toHex(id) + C.toHex(sig)});
  if (!res.ok) throw new Error(`депозит не принят: ${res.error || JSON.stringify(res)}`);
  const fin = await waitSeq(api, s.index, body.seq);
  if (!fin) throw new Error("депозит не финализировался за 12 с");
  return C.txIdHex(body);
}

async function sendPoolCmd(api: NodeApi, s: WalletSession, payload: Record<string, unknown>): Promise<{cid: string; res: any}> {
  const provider = s.provider;
  const clean = {...payload, acct: s.index};
  const sig = await provider.sign(C.DOMAIN.POOL, C.canonicalJson(clean));
  const cmd = {...clean, sig: C.toHex(sig)};
  const cid = C.poolCmdId(cmd);
  const res = await api.post<any>("/pool", cmd);
  return {cid, res};
}

export async function poolCreate(
  api: NodeApi,
  s: WalletSession,
  curA: number,
  scaleAmtA: bigint,
  curB: number,
  scaleAmtB: bigint,
  feeBps = 20
): Promise<OpResult> {
  if (s.index == null) throw new Error("аккаунт не зарегистрирован");
  const {cid} = await sendPoolCmd(api, s, {kind: "pool_create", cur_a: curA, cur_b: curB, nonce: Date.now(), fee_bps: feeBps});
  let pid: number | null = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const pools = await api.pools();
    const m = pools.find((p) => p.cmd === cid);
    if (m) {
      pid = m.pid;
      break;
    }
  }
  if (pid == null) return {ok: false, msg: "пул не создан за 60 с (сеть простаивает?)"};
  const add = await poolAdd(api, s, pid, curA, scaleAmtA, curB, scaleAmtB);
  return {ok: add.ok, msg: `Пул #${pid} создан. ${add.msg}`, detail: {pid}};
}

export async function poolAdd(
  api: NodeApi,
  s: WalletSession,
  pid: number,
  curA: number,
  amtA: bigint,
  curB: number,
  amtB: bigint
): Promise<OpResult> {
  const pool = await api.pool(pid);
  if ((pool as any).error) return {ok: false, msg: "пул не найден"};
  const before = (await api.lp(s.index!)).positions.find((p) => p.pid === pid)?.shares ?? 0;
  const depA = await depositToPool(api, s, pool.acct, curA, amtA);
  const depB = await depositToPool(api, s, pool.acct, curB, amtB);
  await sendPoolCmd(api, s, {kind: "pool_add", pid, dep_a: depA, dep_b: depB});
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const now = (await api.lp(s.index!)).positions.find((p) => p.pid === pid)?.shares ?? 0;
    if (now > before) return {ok: true, msg: `Ликвидность внесена: +${now - before} долей (всего ${now})`};
  }
  return {ok: false, msg: "исполнение не подтверждено за 60 с"};
}

export async function poolSwap(api: NodeApi, s: WalletSession, pid: number, giveCur: number, giveAmt: bigint, minOut: bigint): Promise<OpResult> {
  const pool = await api.pool(pid);
  if ((pool as any).error) return {ok: false, msg: "пул не найден"};
  if (giveCur !== pool.cur_a && giveCur !== pool.cur_b) return {ok: false, msg: "отдаваемая валюта не из этого пула"};
  const outCur = giveCur === pool.cur_a ? pool.cur_b : pool.cur_a;
  const outBefore = Number((await api.account(s.index!)).balances[String(outCur)] ?? 0);
  const dep = await depositToPool(api, s, pool.acct, giveCur, giveAmt);
  await sendPoolCmd(api, s, {kind: "pool_swap", pid, dep, min_out: Number(minOut), expire_round: 0});
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const bal = (await api.account(s.index!)).balances;
    const outNow = Number(bal[String(outCur)] ?? 0);
    if (outNow > outBefore) return {ok: true, msg: `Своп исполнен: +${outNow - outBefore} мин.ед. валюты #${outCur}`};
  }
  return {ok: false, msg: "своп не исполнен за 60 с (либо min_out не достигнут — депозит возвращён)"};
}

export async function poolRemove(api: NodeApi, s: WalletSession, pid: number, shares: number): Promise<OpResult> {
  const have = (await api.lp(s.index!)).positions.find((p) => p.pid === pid)?.shares ?? 0;
  if (have <= 0) return {ok: false, msg: "нет позиции LP в этом пуле"};
  const want = shares > 0 ? Math.min(shares, have) : have;
  await sendPoolCmd(api, s, {kind: "pool_remove", pid, shares: want});
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const now = (await api.lp(s.index!)).positions.find((p) => p.pid === pid)?.shares ?? 0;
    if (now <= have - want) return {ok: true, msg: `Выведено ${want} долей из пула #${pid}`};
  }
  return {ok: false, msg: "вывод не подтверждён за 60 с"};
}

// ── стейкинг ──────────────────────────────────────────────────────────────────────
async function sendStakeCmd(api: NodeApi, s: WalletSession, payload: Record<string, unknown>): Promise<any> {
  const clean = {...payload, acct: s.index};
  const sig = await s.provider.sign(C.DOMAIN.STAKE, C.canonicalJson(clean));
  return api.post<any>("/stake", {...clean, sig: C.toHex(sig)});
}

export async function stakeIssuer(api: NodeApi, s: WalletSession, currency: number, issuerAcct: number, amount: bigint): Promise<OpResult> {
  const before = (await api.stakes(s.index!)).issuer.find((p) => p.cur === currency)?.amount ?? 0;
  const dep = await depositToPool(api, s, issuerAcct, currency, amount);
  await sendStakeCmd(api, s, {kind: "stake", cur: currency, dep, strategy: "issuer"});
  const want = before + Number(amount);
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const now = (await api.stakes(s.index!)).issuer.find((p) => p.cur === currency)?.amount ?? 0;
    if (now >= want) return {ok: true, msg: `Стейк учтён: позиция ${now} мин.ед. валюты #${currency}`};
  }
  return {ok: false, msg: "исполнение не подтверждено за 60 с"};
}

export async function unstakeIssuer(api: NodeApi, s: WalletSession, currency: number, amount: bigint): Promise<OpResult> {
  const before = (await api.stakes(s.index!)).issuer.find((p) => p.cur === currency)?.amount ?? 0;
  if (before <= 0) return {ok: false, msg: "нет issuer-позиции в этой валюте"};
  await sendStakeCmd(api, s, {kind: "unstake", cur: currency, amount: Number(amount), strategy: "issuer"});
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const now = (await api.stakes(s.index!)).issuer.find((p) => p.cur === currency)?.amount ?? 0;
    if (now < before) return {ok: true, msg: "Анстейк исполнен: позиция уменьшилась, средства зачислены"};
  }
  return {ok: false, msg: "вывод не подтверждён за 60 с"};
}
