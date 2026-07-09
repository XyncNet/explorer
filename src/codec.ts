// Порт кодека и подписи Xync в браузер. Полностью совместим с
// xync/common/codec.py и xync/common/crypto.py — байты на проводе идентичны,
// поэтому нода принимает подписанные здесь транзакции без изменений.
//
// Формат v1: тело tx = 16 байт битовой упаковки (= ID), подпись ed25519 64 байта.
//   currency 8 | amount 40 | seq 22 | fee 2 | to 28 | from 28  (128 бит, big-endian)
// Подпись: ed25519(DOMAIN + message), сид приватного ключа — 32 байта.

import {ed25519} from "@noble/curves/ed25519.js";
import {sha256} from "@noble/hashes/sha2.js";

// ── доменные префиксы (crypto.py) ────────────────────────────────────────────
const enc = new TextEncoder();
export const DOMAIN = {
  TX: enc.encode("XYNC:TX:"),
  SWP: enc.encode("XYNC:SWP:"),
  REQ: enc.encode("XYNC:REQ:"),
  XIN: enc.encode("XYNC:XIN:"),
  REG: enc.encode("XYNC:REG:"),
  POOL: enc.encode("XYNC:POOL:"),
  STAKE: enc.encode("XYNC:STK:"),
} as const;

// ── границы полей формата v1 (codec.py) ──────────────────────────────────────
export const TX_SIZE = 16;
export const SIG_SIZE = 64;
export const WIRE_SIZE = TX_SIZE + SIG_SIZE; // 80
export const SWAP_WIRE_SIZE = 2 * TX_SIZE + 2 * SIG_SIZE; // 160
export const RATE_SCALE = 1_000_000_000n;

export const MAX = {
  CURRENCY: (1n << 8n) - 1n,
  AMOUNT: (1n << 40n) - 1n,
  SEQ: (1n << 22n) - 1n,
  FEE: (1n << 2n) - 1n,
  ACCOUNT: (1n << 28n) - 1n,
};

// ── hex-утилиты ──────────────────────────────────────────────────────────────
export const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const fromHex = (h: string): Uint8Array => {
  const s = h.replace(/^0x/, "");
  if (s.length % 2) throw new Error("нечётная длина hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const concat = (...arrs: Uint8Array[]): Uint8Array => {
  const n = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

// ── тело транзакции (TxBody) ─────────────────────────────────────────────────
export interface TxBody {
  currency: number;
  amount: number | bigint;
  seq: number;
  fee: number;
  to: number;
  frm: number;
}

const big = (x: number | bigint): bigint => (typeof x === "bigint" ? x : BigInt(x));

export const validateBody = (b: TxBody): void => {
  const cur = big(b.currency), amt = big(b.amount), seq = big(b.seq),
    fee = big(b.fee), to = big(b.to), frm = big(b.frm);
  if (cur < 0n || cur > MAX.CURRENCY) throw new Error(`currency вне диапазона: ${b.currency}`);
  if (amt < 1n || amt > MAX.AMOUNT) throw new Error(`amount вне диапазона: ${b.amount}`);
  if (seq < 1n || seq > MAX.SEQ) throw new Error(`seq вне диапазона: ${b.seq}`);
  if (fee < 0n || fee > MAX.FEE) throw new Error(`fee-уровень вне диапазона: ${b.fee}`);
  if (to < 0n || to > MAX.ACCOUNT) throw new Error(`to вне диапазона: ${b.to}`);
  if (frm < 0n || frm > MAX.ACCOUNT) throw new Error(`from вне диапазона: ${b.frm}`);
  if (to === frm) throw new Error("перевод самому себе запрещён");
};

/** Упаковать тело в 16 байт (это и есть ID транзакции). */
export const packBody = (b: TxBody): Uint8Array => {
  validateBody(b);
  const v =
    (big(b.currency) << 120n) |
    (big(b.amount) << 80n) |
    (big(b.seq) << 58n) |
    (big(b.fee) << 56n) |
    (big(b.to) << 28n) |
    big(b.frm);
  const out = new Uint8Array(TX_SIZE);
  let x = v;
  for (let i = TX_SIZE - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};

export const unpackBody = (raw: Uint8Array): TxBody => {
  if (raw.length !== TX_SIZE) throw new Error(`ожидалось ${TX_SIZE} байт, получено ${raw.length}`);
  let v = 0n;
  for (const byte of raw) v = (v << 8n) | BigInt(byte);
  const body: TxBody = {
    currency: Number((v >> 120n) & MAX.CURRENCY),
    amount: (v >> 80n) & MAX.AMOUNT,
    seq: Number((v >> 58n) & MAX.SEQ),
    fee: Number((v >> 56n) & MAX.FEE),
    to: Number((v >> 28n) & MAX.ACCOUNT),
    frm: Number(v & MAX.ACCOUNT),
  };
  validateBody(body);
  return body;
};

export const txIdHex = (b: TxBody): string => toHex(packBody(b));

/** UUID-представление тела (та самая идея «tx = UUID»). */
export const txUuid = (b: TxBody): string => {
  const h = txIdHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

// ── подпись ed25519 (crypto.py) ──────────────────────────────────────────────
export const sign = (privSeed: Uint8Array, domain: Uint8Array, message: Uint8Array): Uint8Array =>
  ed25519.sign(concat(domain, message), privSeed);

export const verify = (pub: Uint8Array, domain: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean => {
  try {
    return ed25519.verify(sig, concat(domain, message), pub);
  } catch {
    return false;
  }
};

export const pubFromSeed = (privSeed: Uint8Array): Uint8Array => ed25519.getPublicKey(privSeed);

export const sha256_16 = (data: Uint8Array): Uint8Array => sha256(data).slice(0, 16);
export const sha256hex = (data: Uint8Array): string => toHex(sha256(data));

// ── подписанные кадры ────────────────────────────────────────────────────────
/** Подписанная транзакция (80 байт hex). Подпись — DOMAIN_TX над телом. */
export const signedTxHex = (privSeed: Uint8Array, body: TxBody): string => {
  const id = packBody(body);
  const sig = sign(privSeed, DOMAIN.TX, id);
  return toHex(concat(id, sig));
};

export interface SwapLegs {
  bodyA: TxBody; // нога A: from=A отдаёт cur_X, to=B
  bodyB: TxBody; // нога B: from=B отдаёт cur_Y, to=A
}

export const swapPairId = (a: TxBody, b: TxBody): string => toHex(sha256_16(concat(packBody(a), packBody(b))));

/** Сообщение подписи свопа: id_a ‖ id_b (обе ноги подписывают его, DOMAIN_SWP). */
export const swapPairMsg = (a: TxBody, b: TxBody): Uint8Array => concat(packBody(a), packBody(b));

/** Полу-своп (96 байт hex): body_a ‖ body_b ‖ sig одной стороны над парой. */
export const halfSwapHex = (privSeed: Uint8Array, a: TxBody, b: TxBody): string => {
  const sig = sign(privSeed, DOMAIN.SWP, swapPairMsg(a, b));
  return toHex(concat(packBody(a), packBody(b), sig));
};

/** Собрать полный своп (160 байт hex) из полу-свопа + подписи второй стороны. */
export const fullSwapHex = (a: TxBody, b: TxBody, sigA: Uint8Array, sigB: Uint8Array): string =>
  toHex(concat(packBody(a), packBody(b), sigA, sigB));

export const parseHalfSwap = (halfHex: string): {a: TxBody; b: TxBody; sigA: Uint8Array} => {
  const raw = fromHex(halfHex);
  if (raw.length !== 2 * TX_SIZE + SIG_SIZE) throw new Error(`это не полу-своп (${raw.length} Б, ожидалось 96)`);
  return {
    a: unpackBody(raw.slice(0, TX_SIZE)),
    b: unpackBody(raw.slice(TX_SIZE, 2 * TX_SIZE)),
    sigA: raw.slice(2 * TX_SIZE, 2 * TX_SIZE + SIG_SIZE),
  };
};

// ── канонический JSON (types.canonical_json) для команд пулов/стейкинга ───────
// sort_keys=True, separators=(",",":") — без пробелов, ключи отсортированы.
export const canonicalJson = (obj: unknown): Uint8Array => enc.encode(canonicalStringify(obj));

function canonicalStringify(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalStringify).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(o[k])).join(",") + "}";
  }
  throw new Error("canonicalJson: неподдерживаемый тип");
}

/** cmd_id команды пула/стейкинга = sha256_16(canonical(payload без sig)). */
export const poolCmdId = (cmd: Record<string, unknown>): string => {
  const {sig: _sig, ...payload} = cmd;
  return toHex(sha256_16(canonicalJson(payload)));
};

/** Подписать команду пула/стейкинга: DOMAIN над canonical(payload без sig). */
export const signCmd = (privSeed: Uint8Array, domain: Uint8Array, payload: Record<string, unknown>): Record<string, unknown> => {
  const {sig: _sig, ...clean} = payload;
  const sig = sign(privSeed, domain, canonicalJson(clean));
  return {...clean, sig: toHex(sig)};
};
