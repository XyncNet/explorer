// Read-панели обозревателя. Каждая — async-функция, возвращающая DOM-узел;
// main.ts обновляет активную панель по таймеру и по событиям.

import {store} from "./store";
import {h, card, stat, table, badge, mono, type Col} from "./ui";
import {fmtAmount, fmtCur, curName, curScale, fmtTime, fmtAgo, rateToDisplay, shortId, feeLevelName} from "./format";
import {takeIntent} from "./walletui";
import type {TxRec, Pool, Intent, MoneyReq, Checkpoint} from "./api";

const acctLink = (idx: number): HTMLElement =>
  h("a", {class: "acct", href: `#/account/${idx}`}, `#${idx}`);

// направление/тип записи истории
function txKindBadge(r: TxRec): HTMLElement {
  if (r.kind === "swap") return badge("своп", "swap");
  if (r.kind?.startsWith("pool")) return badge(r.kind.replace("pool_", "пул:"), "pool");
  if (r.kind === "stake" || r.kind === "unstake") return badge(r.kind, "stake");
  return badge("перевод", "");
}

function txRow(r: TxRec): HTMLElement {
  const c = store.currencies;
  const amount =
    r.kind === "swap"
      ? h("span", {}, `${fmtCur(c, r.currency, r.amount)} `, h("span", {class: "muted"}, "⇄ "), `${fmtCur(c, r.peer_currency!, r.peer_amount!)}`)
      : h("span", {}, fmtCur(c, r.currency, r.amount));
  return h("span", {}, amount);
}

const txCols = (): Col<TxRec>[] => [
  {title: "ID / pair", render: (r) => mono(r.pair_id || r.tx_id, shortId(r.pair_id || r.tx_id))},
  {title: "Тип", render: txKindBadge},
  {title: "От", render: (r) => acctLink(r.from)},
  {title: "Кому", render: (r) => acctLink(r.to)},
  {title: "Сумма", render: txRow},
  {title: "seq", render: (r) => h("span", {class: "muted"}, String(r.seq ?? "—")), cls: "num"},
  {
    title: "Финальность",
    render: (r) =>
      r.commit_round
        ? badge(`r=${r.commit_round}`, "ok")
        : badge("fastpath", "fast"),
  },
  {title: "Время", render: (r) => h("span", {title: fmtTime(r.commit_ms || r.settled_ms)}, fmtAgo(r.commit_ms || r.settled_ms))},
];

// ── Дашборд ───────────────────────────────────────────────────────────────────
export async function panelDashboard(): Promise<HTMLElement> {
  if (!store.status) await store.refreshStatus(); // фетч только при первом заходе; дальше — таймер main
  const st = store.status;
  const root = h("div", {class: "col"});
  if (!st) return h("div", {class: "empty"}, store.lastError || "нет связи с нодой");
  const s = st.state, m = st.mempool, cs = st.consensus;
  const phase = store.validators ? `n=${Object.keys(store.validators.validators).length}, кворум ${store.validators.quorum}` : "—";

  root.append(
    h("div", {class: "grid stats"},
      stat("Чейн", st.chain, `валидатор v${st.validator}`),
      stat("Закоммичено раундов", String(s.committed_rounds), `DAG-раунд ${cs.round}, решён ${cs.decided_round}`),
      stat("Аккаунтов", String(s.accounts), phase),
      stat("Финализировано tx", String(s.settled), `отклонено ${s.rejected}`),
      stat("Пул комиссий", `${fmtAmount(s.fee_pool, curScale(store.currencies, 0))} XYNC`, `сожжено ${fmtAmount(s.burned || 0, 6)} XYNC`),
      stat("Последний чекпоинт", s.checkpoint ? `r=${s.checkpoint.round}` : "—", s.checkpoint ? `root ${shortId(s.checkpoint.root, 8, 6)}` : ""),
    ),
    h("div", {class: "grid two"},
      card("Мемпул",
        h("div", {class: "kv"},
          kv("В полёте (переводы)", String(m.pending)),
          kv("В полёте (свопы)", String(m.pending_swaps)),
          kv("Запаркованы (дырки seq)", String(m.parked)),
          kv("Запросы денег", String(m.requests)),
          kv("Обменные интенты", String(m.intents)),
          kv("Предложения по интентам", String(m.proposals)),
          kv("Заморожены (даблспенд)", m.frozen.length ? m.frozen.map((x) => `#${x}`).join(", ") : "нет"),
          kv("Бесплатная полоса", m.accept_free ? "принимает fee=0" : "off"),
        )),
      card("Консенсус (ленивый DAG)",
        h("div", {class: "kv"},
          kv("Текущий раунд", String(cs.round)),
          kv("Решённый раунд", String(cs.decided_round)),
          kv("Блоков в DAG", String(cs.dag_blocks)),
          kv("Очередь сертификатов", String(cs.queue_certs)),
          kv("Очередь системных tx", String(cs.queue_sys)),
          kv("Забанено аккаунтов", String(s.banned || 0)),
          kv("Зарегистрировано", String(s.registered)),
        )),
    ),
  );
  return root;
}

const kv = (k: string, v: string): HTMLElement => h("div", {class: "kv-row"}, h("span", {class: "kv-k"}, k), h("span", {class: "kv-v"}, v));

// ── Транзакции ────────────────────────────────────────────────────────────────
export async function panelTransactions(): Promise<HTMLElement> {
  const recent = (await store.api.recent()).slice().reverse();
  return h("div", {class: "col"},
    h("div", {class: "muted small"}, `Глобальная лента последних расчётов (нода хранит до 200). Свопы показаны обеими ногами.`),
    table(txCols(), recent, "пока нет расчётов"));
}

// ── Чекпоинты ─────────────────────────────────────────────────────────────────
export async function panelCheckpoints(): Promise<HTMLElement> {
  // Полная история — прямым эндпоинтом /checkpoints; клиентский кэш как фолбэк.
  let cps: Checkpoint[] = [];
  try {
    cps = await store.api.checkpoints();
    for (const cp of cps) store.rememberCheckpoint(cp);
  } catch {
    cps = [...store.checkpoints.values()];
  }
  cps = cps.slice().sort((a, b) => b.round - a.round);
  const cols: Col<Checkpoint>[] = [
    {title: "Раунд", render: (c) => badge(`r=${c.round}`, "ok"), cls: "num"},
    {title: "Корень состояния", render: (c) => mono(c.root, shortId(c.root, 10, 8))},
    {title: "Аккаунтов", render: (c) => String(c.accounts), cls: "num"},
    {title: "Settled", render: (c) => String(c.settled), cls: "num"},
    {title: "Начислений эмитента", render: (c) => String(c.issuer_events?.length || 0), cls: "num"},
    {title: "Время", render: (c) => h("span", {title: fmtTime(c.ts)}, fmtAgo(c.ts))},
  ];
  return h("div", {class: "col"},
    h("div", {class: "muted small"},
      "Чекпоинт = корень состояния (sha256) + распределение комиссий раз в N закоммиченных раундов. ",
      "Полная история — из эндпоинта ноды /checkpoints (до 100)."),
    table(cols, cps, "чекпоинтов ещё не было (сеть недавно поднята)"));
}

// ── Мемпул ────────────────────────────────────────────────────────────────────
export async function panelMempool(): Promise<HTMLElement> {
  let mp: import("./api").MempoolResp;
  try {
    mp = await store.api.mempool();
  } catch (e) {
    // старая нода без /mempool — деградируем на счётчики из /status
    if (!store.status) await store.refreshStatus();
    const m = store.status?.mempool;
    return h("div", {class: "col"},
      h("div", {class: "empty"}, `Детальный список мемпула недоступен: ${e instanceof Error ? e.message : e}`),
      m ? h("div", {class: "grid stats"},
        stat("Переводы в полёте", String(m.pending)),
        stat("Свопы в полёте", String(m.pending_swaps)),
        stat("Запаркованы", String(m.parked)),
        stat("Заморожены", String(m.frozen.length)),
      ) : null);
  }
  const c = store.currencies;
  const live = store.eventLog.filter((e) => ["settled", "swap"].includes(e.type)).slice(0, 20);
  const txCols2: Col<import("./api").PendingTx>[] = [
    {title: "tx_id", render: (t) => mono(t.tx_id, shortId(t.tx_id))},
    {title: "От", render: (t) => acctLink(t.from)},
    {title: "Кому", render: (t) => acctLink(t.to)},
    {title: "Сумма", render: (t) => fmtCur(c, t.currency, t.amount)},
    {title: "seq", render: (t) => String(t.seq), cls: "num"},
    {title: "Возраст", render: (t) => `${Math.round(t.age_ms / 100) / 10}с`},
  ];
  const swCols: Col<import("./api").PendingSwap>[] = [
    {title: "pair_id", render: (s) => mono(s.pair_id, shortId(s.pair_id))},
    {title: "A", render: (s) => acctLink(s.a)},
    {title: "B", render: (s) => acctLink(s.b)},
    {title: "Обмен", render: (s) => `${fmtCur(c, s.cur_a, s.amount_a)} ⇄ ${fmtCur(c, s.cur_b, s.amount_b)}`},
    {title: "Возраст", render: (s) => `${Math.round(s.age_ms / 100) / 10}с`},
  ];
  return h("div", {class: "col"},
    h("div", {class: "grid stats"},
      stat("Переводы в полёте", String(mp.pending.length)),
      stat("Свопы в полёте", String(mp.pending_swaps.length)),
      stat("Запаркованы", String(mp.parked), "дырки в seq отправителя"),
      stat("Заморожены", String(mp.frozen.length), "подозрение в даблспенде"),
    ),
    mp.frozen.length ? card("Замороженные аккаунты", h("div", {class: "row"}, ...mp.frozen.map((x) => badge(`#${x}`, "bad")))) : null,
    card("Переводы в мемпуле (ожидают кворум аттестаций)", table(txCols2, mp.pending, "мемпул пуст (fastpath финализирует за ~0.3 с)")),
    mp.pending_swaps.length ? card("Свопы в мемпуле", table(swCols, mp.pending_swaps, "нет")) : null,
    card("Живой поток финализаций (WebSocket)",
      live.length
        ? table<any>([
            {title: "Тип", render: (e) => badge(e.type, e.type === "swap" ? "swap" : "ok")},
            {title: "От", render: (e) => acctLink(e.tx?.from ?? 0)},
            {title: "Кому", render: (e) => acctLink(e.tx?.to ?? 0)},
            {title: "Сумма", render: (e) => (e.tx ? fmtCur(c, e.tx.currency, e.tx.amount) : "—")},
            {title: "Принято", render: (e) => fmtAgo(e._rx)},
          ], live)
        : h("div", {class: "empty"}, "ждём событий…")),
  );
}

// ── Запросы денег ─────────────────────────────────────────────────────────────
export async function panelRequests(): Promise<HTMLElement> {
  const root = h("div", {class: "col"});
  const input = h("input", {class: "inp", placeholder: "индекс плательщика, напр. 6", value: store.wallet?.index != null ? String(store.wallet.index) : ""}) as HTMLInputElement;
  const out = h("div", {});
  const load = async () => {
    const idx = parseInt(input.value, 10);
    if (isNaN(idx)) {
      out.replaceChildren(h("div", {class: "empty"}, "укажите индекс аккаунта-плательщика"));
      return;
    }
    const reqs = await store.api.requestsFor(idx);
    const cols: Col<MoneyReq>[] = [
      {title: "req_id", render: (r) => mono(r.req_id, shortId(r.req_id))},
      {title: "Просит", render: (r) => acctLink(r.requester)},
      {title: "С плательщика", render: (r) => acctLink(r.payer)},
      {title: "Сумма", render: (r) => fmtCur(store.currencies, r.cur, r.amount)},
      {title: "Создан", render: (r) => fmtAgo(r.ts)},
    ];
    out.replaceChildren(table(cols, reqs, "активных запросов к этому аккаунту нет"));
  };
  input.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && load());
  root.append(
    h("div", {class: "muted small"}, "Запросы денег эфемерны (в блокчейн не пишутся, живут в мемпуле с TTL). Показываются по плательщику."),
    h("div", {class: "row"}, input, h("button", {class: "btn", onClick: load}, "Показать")),
    out);
  void load();
  return root;
}

// ── Обменные интенты ──────────────────────────────────────────────────────────
export async function panelIntents(): Promise<HTMLElement> {
  const intents = await store.api.intents();
  const c = store.currencies;
  const cols: Col<Intent>[] = [
    {title: "intent_id", render: (i) => mono(i.intent_id, shortId(i.intent_id))},
    {title: "Maker", render: (i) => acctLink(i.maker)},
    {title: "Отдаёт", render: (i) => `${curName(c, i.give)}`},
    {title: "Хочет", render: (i) => `${curName(c, i.want)}`},
    {title: "Сумма", render: (i) => `${fmtAmount(i.amount, curScale(c, i.fixed === "give" ? i.give : i.want))} [${i.fixed}]`},
    {title: "Курс ≥", render: (i) => `${rateToDisplay(i.limit, curScale(c, i.give), curScale(c, i.want))} ${curName(c, i.want)}/${curName(c, i.give)}`},
    {title: "Истекает", render: (i) => fmtAgo(i.deadline)},
    {
      title: "",
      render: (i) =>
        store.wallet && store.wallet.index !== i.maker
          ? h("button", {class: "btn xs primary", onClick: () => takeIntent(i)}, "Взять")
          : h("span", {class: "muted"}, i.maker === store.wallet?.index ? "мой" : "—"),
    },
  ];
  return h("div", {class: "col"},
    h("div", {class: "muted small"}, "Broadcast «хочу обменять» — эфемерны, в блокчейн не идут. Исполняются встречным полу-свопом (proposal)."),
    table(cols, intents, "активных интентов нет"));
}

// ── Пулы ликвидности ──────────────────────────────────────────────────────────
export async function panelPools(): Promise<HTMLElement> {
  const pools = await store.api.pools();
  const c = store.currencies;
  const cols: Col<Pool>[] = [
    {title: "Пул", render: (p) => h("span", {}, badge(`#${p.pid}`, "pool"), " ", `${curName(c, p.cur_a)}/${curName(c, p.cur_b)}`)},
    {title: "Резервы", render: (p) => `${fmtAmount(p.ra, curScale(c, p.cur_a))} / ${fmtAmount(p.rb, curScale(c, p.cur_b))}`},
    {title: "Спот-курс", render: (p) => (p.ra ? `1 ${curName(c, p.cur_a)} ≈ ${rateToDisplay(p.spot_a_in_b, curScale(c, p.cur_a), curScale(c, p.cur_b))} ${curName(c, p.cur_b)}` : "—")},
    {title: "Доли", render: (p) => String(p.total_shares), cls: "num"},
    {title: "Комиссия", render: (p) => `${p.fee_bps / 100}%`},
    {title: "Счёт пула", render: (p) => acctLink(p.acct)},
  ];
  return h("div", {class: "col"},
    h("div", {class: "muted small"}, "AMM-пулы (constant-product). Свопы клирятся единой ценой в батче коммита (анти-MEV)."),
    table(cols, pools, "пулов пока нет"));
}

// ── Аккаунты / richlist ───────────────────────────────────────────────────────
export async function panelAccounts(): Promise<HTMLElement> {
  const accts = await store.api.accounts();
  const c = store.currencies;
  type A = import("./api").AccountBrief;
  const cols: Col<A>[] = [
    {title: "Индекс", render: (a) => acctLink(a.index)},
    {title: "Тип", render: (a) => (a.pubkey ? (a.banned ? badge("забанен", "bad") : badge("аккаунт", "")) : badge("счёт пула", "pool"))},
    {title: "pubkey", render: (a) => (a.pubkey ? mono(a.pubkey, shortId(a.pubkey, 8, 6)) : h("span", {class: "muted"}, "—"))},
    {title: "seq", render: (a) => String(a.seq), cls: "num"},
    {
      title: "Балансы",
      render: (a) =>
        h("span", {}, Object.entries(a.balances || {})
          .filter(([, v]) => v)
          .map(([cur, v]) => fmtCur(c, Number(cur), v))
          .join("  ·  ") || "—"),
    },
  ];
  return h("div", {class: "col"},
    h("div", {class: "muted small"}, `Все аккаунты сети (эндпоинт /accounts). Всего: ${accts.length}.`),
    table(cols, accts, "аккаунтов нет"));
}

// ── Транзакция по id (эндпоинт /tx/{id}) ──────────────────────────────────────
export async function panelTx(id: string): Promise<HTMLElement> {
  const rec = await store.api.txById(id);
  if (!rec || (rec as any).error || !("from" in rec))
    return h("div", {class: "col"},
      h("div", {class: "empty"},
        `Транзакция ${shortId(id)} не найдена в истории ноды. `,
        `Возможно, она ещё в мемпуле (не финализирована) или её раунд обрезан после чекпоинта.`));
  return h("div", {class: "col"},
    card(`Транзакция ${shortId(rec.pair_id || rec.tx_id)}`,
      h("div", {class: "kv"},
        kv("ID", rec.pair_id || rec.tx_id),
        kv("Тип", rec.kind || "перевод"),
        kv("От → Кому", `#${rec.from} → #${rec.to}`),
        kv("Сумма", fmtCur(store.currencies, rec.currency, rec.amount)),
        rec.kind === "swap" ? kv("Встречная нога", fmtCur(store.currencies, rec.peer_currency!, rec.peer_amount!)) : "",
        kv("seq", String(rec.seq)),
        kv("Комиссия", `${fmtCur(store.currencies, 0, rec.fee || 0)} (уровень ${feeLevelName(rec.fee_level ?? 1)})`),
        kv("Финальность", rec.commit_round ? `коммит r=${rec.commit_round}` : "fastpath (сертификат кворума)"),
        kv("Время", fmtTime(rec.commit_ms || rec.settled_ms)))));
}

// ── Аккаунт по pubkey (для ссылок из кошелька) ────────────────────────────────
export async function panelPub(pub: string): Promise<HTMLElement> {
  const r = await store.api.accountByPub(pub);
  if (typeof r.index !== "number")
    return h("div", {class: "empty"}, `pubkey ${shortId(pub)} не зарегистрирован в сети`);
  return panelAccount(r.index);
}

// ── Один аккаунт (карточка + история) ─────────────────────────────────────────
export async function panelAccount(idx: number): Promise<HTMLElement> {
  const a = await store.api.account(idx);
  if ((a as any).error) return h("div", {class: "empty"}, `аккаунт #${idx} не найден`);
  const c = store.currencies;
  const hist = (await store.api.history(idx, 50)).slice().reverse();
  const balRows = Object.entries(a.balances || {}).filter(([, v]) => v);
  return h("div", {class: "col"},
    card(`Аккаунт #${a.index}`,
      h("div", {class: "kv"},
        kv("pubkey", a.pubkey || "— (счёт пула)"),
        kv("seq (подтверждён)", String(a.seq)),
        kv("next_seq", String(a.next_seq)),
        kv("Бесплатных сегодня", String(a.free_left)),
        kv("Статус", a.banned ? "ЗАБАНЕН за даблспенд" : "активен"),
      ),
      h("div", {class: "bal-grid"},
        ...balRows.map(([cur, v]) =>
          stat(curName(c, Number(cur)), fmtAmount(v, curScale(c, Number(cur))),
            a.available?.[cur] != null && a.available[cur] !== v ? `доступно ${fmtAmount(a.available[cur], curScale(c, Number(cur)))}` : "")))),
    card("История операций (последние 50)", table(txCols(), hist, "операций нет")));
}

// ── Валидаторы и кворум ───────────────────────────────────────────────────────
export async function panelValidators(): Promise<HTMLElement> {
  await store.refreshMeta();
  const v = store.validators;
  if (!v) return h("div", {class: "empty"}, "нет данных о валидаторах");
  const entries = Object.entries(v.validators);
  const n = entries.length;
  const phase = phaseOf(n, v.quorum);
  const cols = [
    {title: "vid", render: (e: [string, any]) => badge(`v${e[0]}`, "ok")},
    {title: "Аккаунт наград", render: (e: [string, any]) => acctLink(e[1].account)},
    {title: "pubkey", render: (e: [string, any]) => mono(e[1].pubkey, shortId(e[1].pubkey, 8, 6))},
    {title: "p2p", render: (e: [string, any]) => h("span", {class: "muted small"}, e[1].p2p_url || "—")},
  ];
  return h("div", {class: "col"},
    h("div", {class: "grid stats"},
      stat("Валидаторов (n)", String(n)),
      stat("Кворум (2f+1)", String(v.quorum)),
      stat("Версия набора", String(v.version), "растёт при val_add/remove"),
      stat("Фаза децентрализации", phase),
    ),
    card("Набор валидаторов", table(cols as any, entries, "нет валидаторов")));
}

function phaseOf(n: number, q: number): string {
  if (n === 1) return "1 оператор";
  if (n === 2) return "2: второй с вето";
  if (n <= 3) return `${n}: старт BFT`;
  return `${n}: BFT (переживаем f=${Math.floor((n - 1) / 3)})` + ` кворум ${q}`;
}

// ── Фрод, баны, комиссии ──────────────────────────────────────────────────────
export async function panelFraud(): Promise<HTMLElement> {
  if (!store.status) await store.refreshStatus();
  const s = store.status?.state;
  if (!s) return h("div", {class: "empty"}, "нет связи с нодой");
  const scale = curScale(store.currencies, 0);
  const commits = store.eventLog.filter((e) => e.type === "commit");
  const punished = commits.flatMap((e) => (e.punished || []).map((p: any) => ({...p, round: e.round, _rx: e._rx})));
  const checkpoints = commits.filter((e) => e.checkpoint).map((e) => e.checkpoint);
  return h("div", {class: "col"},
    h("div", {class: "grid stats"},
      stat("Забанено за даблспенд", String(s.banned || 0)),
      stat("Сожжено XYNC", fmtAmount(s.burned || 0, scale), "50% штрафа за фрод"),
      stat("Пул комиссий", `${fmtAmount(s.fee_pool, scale)} XYNC`, "распределяется на чекпоинте"),
      stat("Отклонено резервов", String(s.rejected), "таймаут/конфликт"),
    ),
    card("Наказания за даблспенд (из commit-событий)",
      punished.length
        ? table<any>([
            {title: "Раунд", render: (p) => `r=${p.round}`},
            {title: "Забанен", render: (p) => acctLink(p.banned)},
            {title: "Штраф", render: (p) => `${fmtAmount(p.fine, scale)} XYNC`},
            {title: "Репортёр", render: (p) => `v${p.reporter}`},
            {title: "Награда", render: (p) => `${fmtAmount(p.reward, scale)} XYNC`},
          ], punished)
        : h("div", {class: "empty"}, "наказаний не зафиксировано (в этой сессии обозревателя)")),
    card("Распределение комиссий (чекпоинты этой сессии)",
      checkpoints.length
        ? h("div", {class: "muted small"}, `Наблюдалось чекпоинтов: ${checkpoints.length}. Комиссии делятся 50% лидерам раундов, 50% поровну валидаторам.`)
        : h("div", {class: "empty"}, "чекпоинтов ещё не наблюдалось")),
    h("div", {class: "muted small"}, "Фрод-события приходят через WebSocket в commit-пакете. Историю до открытия обозревателя нода не отдаёт."),
  );
}

// ── Живая лента событий ───────────────────────────────────────────────────────
export function panelEvents(): HTMLElement {
  const log = store.eventLog;
  const cols: Col<any>[] = [
    {title: "Тип", render: (e) => badge(e.type, eventKind(e.type))},
    {title: "Детали", render: (e) => h("span", {class: "mono small"}, eventDetail(e))},
    {title: "Принято", render: (e) => fmtAgo(e._rx)},
  ];
  return h("div", {class: "col"},
    h("div", {class: "muted small"}, "Поток /events (WebSocket): settled, swap, commit, pool, stake, issuer — в реальном времени."),
    table(cols, log.slice(0, 100), "ждём событий…"));
}

const eventKind = (t: string): string =>
  ({settled: "ok", swap: "swap", commit: "", pool: "pool", stake: "stake", issuer: "stake"} as Record<string, string>)[t] || "";

function eventDetail(e: any): string {
  const c = store.currencies;
  if (e.type === "settled" || e.type === "swap") {
    const tx = e.tx || {};
    return `#${tx.from} → #${tx.to}  ${tx.currency != null ? fmtCur(c, tx.currency, tx.amount) : ""}`;
  }
  if (e.type === "commit") {
    const parts = [`r=${e.round}`];
    if (e.registered?.length) parts.push(`+${e.registered.length} акк.`);
    if (e.punished?.length) parts.push(`${e.punished.length} бан`);
    if (e.checkpoint) parts.push(`чекпоинт r=${e.checkpoint.round}`);
    return parts.join("  ");
  }
  if (e.type === "pool") return `пул #${e.pid} ${e.kind} акк #${e.acct}`;
  if (e.type === "stake") return `${e.kind} акк #${e.acct}`;
  if (e.type === "issuer") return `эмитент: ${JSON.stringify(e).slice(0, 80)}`;
  return JSON.stringify(e).slice(0, 100);
}
