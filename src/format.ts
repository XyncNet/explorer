// Форматирование сумм/времени/идентификаторов для UI. Суммы — целые
// минимальные единицы делятся на 10^scale (без float в самих значениях протокола;
// float только для отображения). Реестр валют приходит из /currencies.

export interface CurrencyMeta {
  name: string;
  scale: number;
  issuer_acct?: number;
  rate_bps?: number;
}

export type Currencies = Record<number, CurrencyMeta>;

export const curName = (curs: Currencies, code: number): string => curs[code]?.name ?? `#${code}`;

export const curScale = (curs: Currencies, code: number): number => curs[code]?.scale ?? 0;

/** Целые минимальные единицы → человеческая строка с учётом scale. */
export const fmtAmount = (units: number | bigint, scale: number): string => {
  const neg = BigInt(units) < 0n;
  let v = neg ? -BigInt(units) : BigInt(units);
  if (scale === 0) return (neg ? "-" : "") + v.toString();
  const base = 10n ** BigInt(scale);
  const whole = v / base;
  const frac = (v % base).toString().padStart(scale, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
};

/** Человеческая сумма → целые минимальные единицы (Decimal-безопасно, без float). */
export const toUnits = (display: string, scale: number): bigint => {
  const s = display.trim();
  if (!/^-?\d*(\.\d*)?$/.test(s) || s === "" || s === "." || s === "-") throw new Error("некорректная сумма");
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  if (frac.length > scale) throw new Error(`слишком много знаков после запятой (максимум ${scale})`);
  const padded = frac.padEnd(scale, "0");
  const v = BigInt(whole || "0") * 10n ** BigInt(scale) + BigInt(padded || "0");
  return neg ? -v : v;
};

export const fmtCur = (curs: Currencies, code: number, units: number | bigint): string =>
  `${fmtAmount(units, curScale(curs, code))} ${curName(curs, code)}`;

// ── курс свопа (RATE_SCALE = 1e9), поправка на разные scale ───────────────────
const RATE_SCALE = 1_000_000_000n;

export const rateToDisplay = (rate: number | bigint, giveScale: number, wantScale: number): string => {
  // rate/(1e9 * 10^(want-give)); печатаем c 6 знаками, обрезая нули
  const r = Number(rate) / Number(RATE_SCALE) / Math.pow(10, wantScale - giveScale);
  return trimNum(r);
};

export const rateToMinimal = (display: string, giveScale: number, wantScale: number): bigint => {
  // display * 1e9 * 10^(want-give) — целочисленно через toUnits с запасом точности
  const extra = wantScale - giveScale;
  const scale = 9 + Math.max(0, extra);
  const scaled = toUnits(display, scale); // display * 10^scale
  // итог = display * 1e9 * 10^extra = scaled * 10^(9+extra-scale)
  const pow = 9 + extra - scale;
  return pow >= 0 ? scaled * 10n ** BigInt(pow) : scaled / 10n ** BigInt(-pow);
};

const trimNum = (n: number): string => {
  if (!isFinite(n)) return "∞";
  return n.toFixed(6).replace(/\.?0+$/, "");
};

// ── время / идентификаторы ────────────────────────────────────────────────────
export const shortId = (id: string, head = 8, tail = 6): string =>
  id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;

export const fmtTime = (ms?: number | null): string => {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString("ru-RU", {hour12: false});
};

export const fmtAgo = (ms?: number | null): string => {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} дн назад`;
};

export const feeLevelName = (level: number): string =>
  ["free", "base", "×4", "×16"][level] ?? String(level);
