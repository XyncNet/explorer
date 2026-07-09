// UI кошелька: подключение (импорт JSON/seed или внешний XyncConnect), баланс,
// входящие запросы и формы всех операций. Подпись — в провайдере (см. wallet.ts).

import {store} from "./store";
import {h, card, toast, badge, mono, spinner} from "./ui";
import {fmtAmount, fmtCur, curName, curScale, toUnits, rateToMinimal, shortId} from "./format";
import * as W from "./wallet";

let busy = false;

export function renderWalletPanel(): HTMLElement {
  const s = store.wallet;
  if (!s) return card("Кошелёк", connectForm());
  return card(
    `Кошелёк ${s.label}`,
    h("div", {class: "kv"},
      kvRow("pubkey", mono(s.pubkey, shortId(s.pubkey, 8, 6))),
      kvRow("Аккаунт", s.index != null ? badge(`#${s.index}`, "ok") : badge("не зарегистрирован", "bad")),
      kvRow("Провайдер", s.provider.kind === "local" ? "локальный ключ" : "XyncConnect")),
    h("div", {class: "wallet-actions", id: "wallet-balances"}, spinner()),
    s.index == null
      ? h("button", {class: "btn primary", onClick: () => run(async () => {
          const r = await W.register(store.api, s);
          toast(r.msg, r.ok ? "ok" : "bad");
          store.emit();
        })}, "Зарегистрировать аккаунт")
      : opButtons(),
    h("button", {class: "btn ghost", onClick: () => {
      store.wallet = null;
      store.emit();
    }}, "Отключить"),
  );
}

/** Дозагрузка балансов после отрисовки (async). */
export async function hydrateWalletBalances(): Promise<void> {
  const s = store.wallet;
  const box = document.getElementById("wallet-balances");
  if (!s || !box || s.index == null) {
    if (box) box.replaceChildren();
    return;
  }
  try {
    const a = await store.api.account(s.index);
    const c = store.currencies;
    box.replaceChildren(
      h("div", {class: "bal-grid small"},
        ...Object.entries(a.balances || {}).filter(([, v]) => v).map(([cur, v]) =>
          h("div", {class: "bal"}, h("b", {}, fmtAmount(v, curScale(c, Number(cur)))), " ", curName(c, Number(cur))))));
    // входящие запросы к нам
    const reqs = await store.api.requestsFor(s.index);
    if (reqs.length) {
      box.append(h("div", {class: "reqs"},
        h("div", {class: "muted small"}, "Входящие запросы:"),
        ...reqs.map((r) => h("div", {class: "req-row"},
          h("span", {}, `#${r.requester} просит ${fmtCur(c, r.cur, r.amount)}`),
          h("button", {class: "btn xs primary", onClick: () => run(async () => {
            const res = await W.approveRequest(store.api, s, r);
            toast(res.msg, res.ok ? "ok" : "bad");
          })}, "Оплатить"),
          h("button", {class: "btn xs ghost", onClick: () => run(async () => {
            const res = await W.rejectRequest(store.api, s, r.req_id);
            toast(res.msg, res.ok ? "ok" : "bad");
          })}, "Отклонить")))));
    }
  } catch (e) {
    box.replaceChildren(h("div", {class: "muted small"}, String(e)));
  }
}

function connectForm(): HTMLElement {
  const ta = h("textarea", {class: "inp", rows: "3", placeholder: 'сид ключа (64 hex) ИЛИ JSON кошелька {"priv":"…","pub":"…","index":6}'}) as HTMLTextAreaElement;
  const doConnect = () => run(async () => {
    const v = ta.value.trim();
    if (!v) return;
    const s = v.startsWith("{") ? await W.connectWalletJson(store.api, v) : await W.connectLocalSeed(store.api, v);
    store.wallet = s;
    toast(s.index != null ? `Подключён аккаунт #${s.index}` : "Ключ импортирован (аккаунт не зарегистрирован)", "ok");
    store.emit();
  });
  const injectBtn = window.xyncWallet
    ? h("button", {class: "btn", onClick: () => run(async () => {
        const s = new W.XyncConnectProvider(window.xyncWallet!);
        const index = await W.resolveIndex(store.api, s.pubkey);
        store.wallet = {provider: s, pubkey: s.pubkey, index, label: "XyncConnect"};
        toast("Внешний кошелёк подключён", "ok");
        store.emit();
      })}, "Подключить внешний кошелёк (XyncConnect)")
    : null;
  return h("div", {class: "col"},
    h("div", {class: "muted small"}, "Ключ не покидает вкладку — подпись выполняется локально. Для теста используйте wallets/*.json из проекта."),
    ta,
    h("div", {class: "row"}, h("button", {class: "btn primary", onClick: doConnect}, "Подключить ключ"), injectBtn),
  );
}

function opButtons(): HTMLElement {
  const b = (label: string, fn: () => void, cls = "btn") => h("button", {class: cls, onClick: fn}, label);
  return h("div", {class: "op-grid"},
    b("Отправить", () => sendForm(), "btn primary"),
    b("Запросить", () => requestForm()),
    b("P2P-своп", () => swapForm()),
    b("Принять своп", () => swapAcceptForm()),
    b("Новый интент", () => intentForm()),
    b("Создать пул", () => poolCreateForm()),
    b("Пул: своп", () => poolSwapForm()),
    b("Пул: внести", () => poolAddForm()),
    b("Стейк", () => stakeForm()),
  );
}

// ── generic modal + fields ────────────────────────────────────────────────────
type Field = {name: string; label: string; ph?: string; value?: string; type?: string};

function modalForm(title: string, fields: Field[], onSubmit: (vals: Record<string, string>) => Promise<void>, extra?: Node): void {
  const inputs: Record<string, HTMLInputElement> = {};
  const body = h("div", {class: "col"},
    ...fields.map((f) => {
      const inp = h("input", {class: "inp", placeholder: f.ph || "", value: f.value || "", type: f.type || "text"}) as HTMLInputElement;
      inputs[f.name] = inp;
      return h("label", {class: "fld"}, h("span", {}, f.label), inp);
    }),
    extra || null,
  );
  openModal(title, body, async () => {
    const vals: Record<string, string> = {};
    for (const [k, v] of Object.entries(inputs)) vals[k] = v.value.trim();
    await onSubmit(vals);
  });
}

function openModal(title: string, body: Node, onOk: () => Promise<void>, okLabel = "Выполнить"): void {
  const overlay = h("div", {class: "overlay"});
  const close = () => overlay.remove();
  const okBtn = h("button", {class: "btn primary"}, okLabel) as HTMLButtonElement;
  okBtn.addEventListener("click", () =>
    run(async () => {
      await onOk();
    }, () => {
      close();
    }, okBtn));
  overlay.append(h("div", {class: "modal"},
    h("div", {class: "modal-h"}, title, h("span", {class: "x", onClick: close}, "✕")),
    h("div", {class: "modal-b"}, body),
    h("div", {class: "modal-f"}, h("button", {class: "btn ghost", onClick: close}, "Отмена"), okBtn)));
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  document.body.append(overlay);
}

const curOptions = (): string => Object.entries(store.currencies).map(([code, m]) => `${m.name}(${code})`).join(", ");

function resolveCur(input: string): {code: number; scale: number} {
  const t = input.trim().toUpperCase();
  for (const [code, m] of Object.entries(store.currencies)) {
    if (m.name.toUpperCase() === t || code === input.trim()) return {code: Number(code), scale: m.scale};
  }
  throw new Error(`валюта не найдена: ${input} (доступны: ${curOptions()})`);
}

// ── формы операций ─────────────────────────────────────────────────────────────
function sendForm(): void {
  const s = store.wallet!;
  modalForm("Отправить деньги",
    [
      {name: "to", label: "Получатель (индекс)", ph: "7"},
      {name: "cur", label: "Валюта", ph: "USD", value: "XYNC"},
      {name: "amount", label: "Сумма", ph: "12.5"},
      {name: "fee", label: "Fee-уровень (0-3)", value: "1"},
    ],
    async (v) => {
      const {code, scale} = resolveCur(v.cur);
      const res = await W.send(store.api, s, parseInt(v.to, 10), code, toUnits(v.amount, scale), parseInt(v.fee || "1", 10));
      toast(res.msg, res.ok ? "ok" : "bad");
    },
    h("div", {class: "muted small"}, `Валюты: ${curOptions()}`));
}

function requestForm(): void {
  const s = store.wallet!;
  modalForm("Запросить деньги (инвойс)",
    [
      {name: "payer", label: "Плательщик (индекс)", ph: "6"},
      {name: "cur", label: "Валюта", value: "USD"},
      {name: "amount", label: "Сумма", ph: "3"},
    ],
    async (v) => {
      const {code, scale} = resolveCur(v.cur);
      const res = await W.requestMoney(store.api, s, parseInt(v.payer, 10), code, toUnits(v.amount, scale));
      toast(res.msg, res.ok ? "ok" : "bad");
    });
}

function swapForm(): void {
  const s = store.wallet!;
  modalForm("Предложить P2P-своп (шаг 1 — полу-своп)",
    [
      {name: "peer", label: "Контрагент (индекс)", ph: "7"},
      {name: "giveCur", label: "Отдаю: валюта", value: "USD"},
      {name: "give", label: "Отдаю: сумма", ph: "10"},
      {name: "takeCur", label: "Хочу: валюта", value: "EUR"},
      {name: "take", label: "Хочу: сумма", ph: "9"},
    ],
    async (v) => {
      const g = resolveCur(v.giveCur), t = resolveCur(v.takeCur);
      const {half} = await W.swapPropose(store.api, s, parseInt(v.peer, 10), g.code, toUnits(v.give, g.scale), t.code, toUnits(v.take, t.scale));
      await navigator.clipboard?.writeText(half).catch(() => {});
      openModal("Полу-своп готов", h("div", {class: "col"},
        h("div", {class: "muted small"}, "Передайте эту строку контрагенту (скопирована). Он выполнит «Принять своп»."),
        h("textarea", {class: "inp", rows: "4", readonly: "true"}, half)), async () => {}, "Ок");
    });
}

function swapAcceptForm(): void {
  const s = store.wallet!;
  modalForm("Принять полу-своп (шаг 2)",
    [{name: "half", label: "Полу-своп (hex, 96 Б)", ph: "0100…"}],
    async (v) => {
      const res = await W.swapAccept(store.api, s, v.half);
      toast(res.msg, res.ok ? "ok" : "bad");
    });
}

function intentForm(): void {
  const s = store.wallet!;
  modalForm("Опубликовать обменный интент",
    [
      {name: "giveCur", label: "Отдаю: валюта", value: "USD"},
      {name: "wantCur", label: "Хочу: валюта", value: "EUR"},
      {name: "amount", label: "Сумма (в фикс. валюте)", ph: "100"},
      {name: "fixed", label: "Фиксировано (give|want)", value: "give"},
      {name: "limit", label: "Мин. курс want/give", ph: "0.90"},
      {name: "ttl", label: "TTL, сек", value: "900"},
    ],
    async (v) => {
      const g = resolveCur(v.giveCur), w = resolveCur(v.wantCur);
      const fixed = v.fixed === "want" ? "want" : "give";
      const amtScale = fixed === "give" ? g.scale : w.scale;
      const res = await W.intentNew(store.api, s, g.code, w.code, fixed, toUnits(v.amount, amtScale), rateToMinimal(v.limit, g.scale, w.scale), parseInt(v.ttl || "900", 10));
      toast(res.msg, res.ok ? "ok" : "bad");
    });
}

function poolCreateForm(): void {
  const s = store.wallet!;
  modalForm("Создать пул + внести стартовую ликвидность",
    [
      {name: "curA", label: "Валюта A", value: "USD"},
      {name: "amtA", label: "Вклад A", ph: "1000"},
      {name: "curB", label: "Валюта B", value: "EUR"},
      {name: "amtB", label: "Вклад B", ph: "900"},
      {name: "fee", label: "Комиссия пула, bps", value: "20"},
    ],
    async (v) => {
      const a = resolveCur(v.curA), b = resolveCur(v.curB);
      toast("Создаю пул, жду коммитов DAG…");
      const res = await W.poolCreate(store.api, s, a.code, toUnits(v.amtA, a.scale), b.code, toUnits(v.amtB, b.scale), parseInt(v.fee || "20", 10));
      toast(res.msg, res.ok ? "ok" : "bad");
    });
}

function poolAddForm(): void {
  const s = store.wallet!;
  modalForm("Внести ликвидность в пул",
    [
      {name: "pid", label: "Пул (pid)", ph: "9"},
      {name: "amtA", label: "Сумма A", ph: "100"},
      {name: "amtB", label: "Сумма B", ph: "90"},
    ],
    async (v) => {
      const pool = await store.api.pool(parseInt(v.pid, 10));
      if ((pool as any).error) throw new Error("пул не найден");
      const sa = curScale(store.currencies, pool.cur_a), sb = curScale(store.currencies, pool.cur_b);
      toast("Вношу ликвидность, жду исполнения…");
      const res = await W.poolAdd(store.api, s, pool.pid, pool.cur_a, toUnits(v.amtA, sa), pool.cur_b, toUnits(v.amtB, sb));
      toast(res.msg, res.ok ? "ok" : "bad");
    });
}

function poolSwapForm(): void {
  const s = store.wallet!;
  modalForm("Своп через пул ликвидности",
    [
      {name: "pid", label: "Пул (pid)", ph: "9"},
      {name: "giveCur", label: "Отдаю: валюта", value: "USD"},
      {name: "give", label: "Отдаю: сумма", ph: "10"},
      {name: "minOut", label: "Минимум на выходе (0 = любой)", value: "0"},
    ],
    async (v) => {
      const g = resolveCur(v.giveCur);
      const pool = await store.api.pool(parseInt(v.pid, 10));
      if ((pool as any).error) throw new Error("пул не найден");
      const outCur = g.code === pool.cur_a ? pool.cur_b : pool.cur_a;
      const outScale = curScale(store.currencies, outCur);
      toast("Своп через пул, жду исполнения…");
      const res = await W.poolSwap(store.api, s, pool.pid, g.code, toUnits(v.give, g.scale), toUnits(v.minOut || "0", outScale));
      toast(res.msg, res.ok ? "ok" : "bad");
    });
}

function stakeForm(): void {
  const s = store.wallet!;
  modalForm("Застейкать (issuer-процент эмитента)",
    [
      {name: "cur", label: "Валюта", value: "USD"},
      {name: "amount", label: "Сумма", ph: "100"},
    ],
    async (v) => {
      const {code, scale} = resolveCur(v.cur);
      const issuer = store.currencies[code]?.issuer_acct;
      if (issuer == null) throw new Error(`у валюты ${v.cur} нет эмитента — issuer-стейк невозможен`);
      toast("Стейк, жду коммита…");
      const res = await W.stakeIssuer(store.api, s, code, issuer, toUnits(v.amount, scale));
      toast(res.msg, res.ok ? "ok" : "bad");
    });
}

// ── утилиты ────────────────────────────────────────────────────────────────────
const kvRow = (k: string, v: Node | string): HTMLElement => h("div", {class: "kv-row"}, h("span", {class: "kv-k"}, k), h("span", {class: "kv-v"}, v as any));

async function run(fn: () => Promise<void>, onOk?: () => void, btn?: HTMLButtonElement): Promise<void> {
  if (busy) return;
  busy = true;
  if (btn) {
    btn.disabled = true;
    btn.dataset.label = btn.textContent || "";
    btn.textContent = "…";
  }
  try {
    await fn();
    onOk?.();
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e), "bad");
  } finally {
    busy = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = btn.dataset.label || "Ок";
    }
  }
}

/** Проведение интента из списка (кнопка на панели интентов). */
export function takeIntent(it: import("./api").Intent): void {
  const s = store.wallet;
  if (!s) return toast("Сначала подключите кошелёк", "bad");
  run(async () => {
    const res = await W.intentTake(store.api, s, it);
    toast(res.msg, res.ok ? "ok" : "bad");
  });
}
