// Точка входа: раскладка (шапка, вкладки, боковая панель кошелька), hash-роутинг,
// авто-обновление активной панели по таймеру и по событиям WebSocket.

import "./styles.css";
import {store, NODES} from "./store";
import {h, clear, spinner, toast} from "./ui";
import * as P from "./panels";
import {renderWalletPanel, hydrateWalletBalances} from "./walletui";

interface Tab {
  id: string;
  title: string;
  render: () => Promise<HTMLElement> | HTMLElement;
}

const TABS: Tab[] = [
  {id: "dashboard", title: "Статус", render: P.panelDashboard},
  {id: "txs", title: "Транзакции", render: P.panelTransactions},
  {id: "checkpoints", title: "Чекпоинты", render: P.panelCheckpoints},
  {id: "mempool", title: "Мемпул", render: P.panelMempool},
  {id: "requests", title: "Запросы денег", render: P.panelRequests},
  {id: "intents", title: "Обменные интенты", render: P.panelIntents},
  {id: "pools", title: "Пулы ликвидности", render: P.panelPools},
  {id: "accounts", title: "Аккаунты", render: P.panelAccounts},
  {id: "validators", title: "Валидаторы", render: P.panelValidators},
  {id: "fraud", title: "Фрод и комиссии", render: P.panelFraud},
  {id: "events", title: "Лента событий", render: P.panelEvents},
];

let current = {tab: "dashboard", arg: ""};
let refreshTimer: number | undefined;

function parseHash(): {tab: string; arg: string} {
  const hash = location.hash.replace(/^#\/?/, "");
  const [tab, arg] = hash.split("/");
  return {tab: tab || "dashboard", arg: arg || ""};
}

async function renderMain(): Promise<void> {
  const main = document.getElementById("main")!;
  clear(main);
  main.append(spinner());
  try {
    let node: HTMLElement;
    if (current.tab === "account") node = await P.panelAccount(parseInt(current.arg, 10));
    else if (current.tab === "pub") node = await P.panelPub(current.arg);
    else if (current.tab === "tx") node = await P.panelTx(current.arg);
    else {
      const tab = TABS.find((t) => t.id === current.tab) || TABS[0];
      node = await tab.render();
    }
    clear(main);
    main.append(node);
  } catch (e) {
    clear(main);
    main.append(h("div", {class: "empty"}, `Ошибка загрузки: ${e instanceof Error ? e.message : e}`));
  }
}

function renderTabs(): void {
  const nav = document.getElementById("tabs")!;
  clear(nav);
  for (const t of TABS) {
    nav.append(h("a", {
      class: "tab" + (current.tab === t.id ? " active" : ""),
      href: `#/${t.id}`,
    }, t.title));
  }
}

function renderHeader(): void {
  const head = document.getElementById("head")!;
  clear(head);
  const sel = h("select", {class: "node-sel", onChange: (e: Event) => {
    void store.setNode((e.target as HTMLSelectElement).value).then(() => {
      renderTabs();
      void renderMain();
      renderSidebar();
    });
  }}) as HTMLSelectElement;
  for (const n of NODES) {
    const opt = h("option", {value: n.id}, n.label) as HTMLOptionElement;
    if (n.id === store.nodeId) opt.selected = true;
    sel.append(opt);
  }
  const search = h("input", {class: "search", placeholder: "Поиск: индекс аккаунта, tx_id или pubkey…"}) as HTMLInputElement;
  search.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Enter") return;
    void doSearch(search.value.trim());
  });
  const status = h("span", {class: "conn" + (store.lastError ? " bad" : " ok"), id: "conn"}, store.lastError ? "нет связи" : "онлайн");
  head.append(
    h("a", {class: "brand", href: "#/dashboard"},
      h("img", {class: "logo-img", src: "/logo.svg", alt: "Xync"}),
      h("span", {class: "muted brand-sub"}, "Explorer")),
    search,
    h("div", {class: "head-r"}, sel, status),
  );
}

async function doSearch(q: string): Promise<void> {
  if (!q) return;
  if (/^\d+$/.test(q)) {
    location.hash = `#/account/${q}`;
    return;
  }
  if (/^[0-9a-fA-F]{64}$/.test(q)) {
    // pubkey → индекс
    const r = await store.api.accountByPub(q);
    if (typeof r.index === "number") location.hash = `#/account/${r.index}`;
    else toast("pubkey не найден", "bad");
    return;
  }
  toast("Формат не распознан. Введите индекс или 64-hex pubkey.", "bad");
}

function renderSidebar(): void {
  const side = document.getElementById("side")!;
  clear(side);
  side.append(renderWalletPanel());
  void hydrateWalletBalances();
}

function onRoute(): void {
  current = parseHash();
  renderTabs();
  renderHeader();
  void renderMain();
}

const LIVE_TABS = ["dashboard", "fraud", "mempool", "txs", "events"];

function updateConn(): void {
  const conn = document.getElementById("conn");
  if (conn) {
    conn.className = "conn " + (store.lastError ? "bad" : "ok");
    conn.textContent = store.lastError ? "нет связи" : "онлайн";
  }
}

function scheduleRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  // Единый поллинг: один запрос /status раз в 5 с (refreshStatus без emit —
  // не зацикливается), затем перерисовка активной «живой» вкладки.
  refreshTimer = window.setInterval(async () => {
    await store.refreshStatus();
    updateConn();
    if (LIVE_TABS.includes(current.tab)) void renderMain();
  }, 5000);
}

let sidebarDebounce: number | undefined;
function scheduleSidebar(): void {
  if (sidebarDebounce) return;
  sidebarDebounce = window.setTimeout(() => {
    sidebarDebounce = undefined;
    renderSidebar();
  }, 400);
}

async function boot(): Promise<void> {
  document.getElementById("app")!.append(
    h("header", {id: "head"}),
    h("nav", {id: "tabs"}),
    h("div", {class: "body"}, h("main", {id: "main"}), h("aside", {id: "side"})),
  );
  await store.init();
  store.subscribe(() => {
    // WS-событие / смена кошелька: боковую панель обновляем с дебаунсом
    // (не фетчим баланс на каждое событие), «Ленту событий» — дёшево (без фетча).
    // Dashboard/fraud/mempool живут на таймере 5 с, чтобы не спамить /status.
    scheduleSidebar();
    if (current.tab === "events") void renderMain();
  });
  window.addEventListener("hashchange", onRoute);
  onRoute();
  renderSidebar();
  scheduleRefresh();
}

void boot();
