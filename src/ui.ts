// Мини-хелперы DOM без фреймворка: создание элементов, таблицы, бейджи, тосты.

type Attrs = Record<string, any>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") for (const [dk, dv] of Object.entries(v as object)) (el.dataset as any)[dk] = dv;
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c as Node | string);
  return el;
}

export const clear = (el: HTMLElement): void => {
  el.replaceChildren();
};

export const badge = (text: string, kind = ""): HTMLElement => h("span", {class: `badge ${kind}`}, text);

/** Ячейка-моноширинный id с копированием по клику. */
export const mono = (full: string, short?: string): HTMLElement => {
  const el = h("span", {class: "mono copy", title: full + " (клик — копировать)"}, short ?? full);
  el.addEventListener("click", () => {
    navigator.clipboard?.writeText(full).then(() => toast("Скопировано"));
  });
  return el;
};

export interface Col<T> {
  title: string;
  render: (row: T) => Node | string;
  cls?: string;
}

export function table<T>(cols: Col<T>[], rows: T[], empty = "нет данных"): HTMLElement {
  if (!rows.length) return h("div", {class: "empty"}, empty);
  const thead = h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", {class: c.cls}, c.title))));
  const tbody = h(
    "tbody",
    {},
    ...rows.map((r) => h("tr", {}, ...cols.map((c) => h("td", {class: c.cls}, c.render(r) as any))))
  );
  return h("div", {class: "table-wrap"}, h("table", {}, thead, tbody));
}

export const card = (title: string, ...body: Child[]): HTMLElement =>
  h("div", {class: "card"}, h("div", {class: "card-h"}, title), h("div", {class: "card-b"}, ...body));

export const stat = (label: string, value: string | Node, sub?: string): HTMLElement =>
  h("div", {class: "stat"}, h("div", {class: "stat-v"}, value as any), h("div", {class: "stat-l"}, label), sub ? h("div", {class: "stat-s"}, sub) : null);

let toastTimer: number | undefined;
export function toast(msg: string, kind = ""): void {
  let box = document.getElementById("toast");
  if (!box) {
    box = h("div", {id: "toast"});
    document.body.append(box);
  }
  box.className = kind;
  box.textContent = msg;
  box.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box!.classList.remove("show"), 3200);
}

export const spinner = (): HTMLElement => h("div", {class: "spinner"});
