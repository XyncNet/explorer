# Xync Explorer

Обозреватель блокчейна Xync Network + web3-кошелёк в стиле etherscan. Отдельный
frontend-проект (Vite + vanilla TS, минимум зависимостей). Читает публичный
api-сервис валидатора и проводит операции, подписывая их локально в браузере.

На ноду добавлены read-эндпоинты для обозревателя (`/checkpoints`, `/accounts`,
`/tx/{id}`, `/mempool`) и CORS — см. раздел «Правки ноды».

## Что показывает

**Read-панели:** статус-дашборд · транзакции и свопы (глобальная лента) ·
чекпоинты · мемпул · запросы денег · обменные интенты · пулы ликвидности ·
аккаунты/richlist · валидаторы и кворум (фаза децентрализации) · фрод/баны/
комиссии · живая лента событий (WebSocket).

**Кошелёк (операции из веба):** перевод, запрос денег и оплата/отклонение,
P2P-своп (полу-своп → приём), обменные интенты (создать/взять), пулы
(создать/внести/своп/вывести), issuer-стейкинг, регистрация аккаунта. Подпись
ed25519 выполняется во вкладке — приватный ключ на ноду не уходит.

## Быстрый старт (локально)

```bash
# 1) поднять локальную сеть валидаторов (из корня проекта)
python3 scripts/run_local.py --validators 4      # api: v1=7105 … v4=7405

# 2) обозреватель
cd explorer
npm install
npm run dev            # http://localhost:5280
```

Переключение между валидаторами — селектор в шапке (n1…n4). Для теста кошелька
подключите любой `wallets/*.json` из проекта (например alice = аккаунт #6).

### Продакшн-ноды

Адреса api-нод задаются через окружение (`.env`), CORS не требуется — dev-сервер
проксирует их под same-origin путь `/n1…/n4`:

```
VITE_N1=https://api.xync.net
VITE_N2=https://api2.xync.net
```

`npm run build` → статика в `dist/`. При деплое поставьте `dist/` за reverse-proxy,
который отдаёт `/n1/*` на api-ноду (пример nginx — в конце файла), **или**
включите CORS на ноде (опциональный патч ниже).

## Совместимость с протоколом (проверено)

`src/codec.ts` — точный порт `xync/common/codec.py` + `crypto.py`: битовая
упаковка тела (16 Б = ID), доменные префиксы, ed25519. Проверено двумя способами:

- **байт-в-байт с нодой** — подпись tx, tx_id, UUID, полу-своп, pair_id, подпись
  и cmd_id команды пула, canonical JSON, вывод pubkey из сида совпали с выводом
  Python-ноды;
- **e2e против живой сети** — нода приняла JS-подписанную транзакцию (`ok:attested`),
  баланс получателя переехал ровно на сумму за fastpath (кворум 3 из 4).

## Правки ноды

Внесены прямо в ноду (тонкие read-эндпоинты + CORS, без бизнес-логики):

| Файл | Что добавлено |
|---|---|
| `xync/api/service.py` | CORS-middleware (`Access-Control-Allow-Origin: *`) + прокси `/checkpoints`, `/accounts`, `/tx/{id}`, `/mempool` |
| `xync/state/service.py` | `/checkpoints` (история, до 100) · `/accounts` (richlist одним запросом) · `/tx/{id}` (расчёт по tx_id/pair_id из `tx_meta`) |
| `xync/mempool/service.py` | `/pending` — распакованные pending-переводы и свопы + frozen |

CORS «*» безопасен для этого API: у ноды нет ключей, она видит только подписанные
байты. Инварианты не затронуты (`selfcheck.py` → 46/46), проверено живой сетью.
Благодаря CORS собранный `dist/` можно открывать и напрямую (без dev-прокси),
указав в коде базовый URL ноды.

## Кошелёк: подключение

1. **Локальный ключ** — вставить сид (64 hex) или `wallets/*.json`. Подпись —
   в браузере (`LocalKeyProvider`).
2. **Внешний кошелёк (XyncConnect)** — если во вкладку внедрён `window.xyncWallet`
   (см. ниже), кнопка «Подключить внешний кошелёк» использует его для подписи.

### Протокол XyncConnect (для xma / mini-app)

Обозреватель — dApp, кошелёк — источник подписи (ключ у кошелька, как в TON Connect).
Достаточно реализовать инъекцию:

```ts
window.xyncWallet = {
  pubkey: "<hex ed25519 аккаунта>",
  // domainHex/messageHex — hex; вернуть hex 64-байтовой подписи ed25519(domain‖message)
  async sign(domainHex: string, messageHex: string): Promise<string> { /* подпись ключом кошелька */ },
};
```

Всё построение тел/команд и отправку на ноду берёт на себя обозреватель
(`src/wallet.ts`) — кошелёк только подписывает произвольное `domain‖message`.

## Что дописано в кошельке xma

Чейн `xync` уже был в типе `ChainId`, но адаптера не было (проект не
тайпчекался). Добавлено (`/Users/xync/www/xync/front/xma`):

- `src/web3/chains/xync.ts` — `ChainAdapter` сети Xync (деривация SLIP-10 ed25519,
  импорт ключа, балансы/перевод через api-ноду, ссылки на этот обозреватель);
- `src/web3/registry.ts` — регистрация чейна (CHAINS, CHAIN_META, ленивый лоадер);
- `src/web3/tokens.ts` — токены Xync (натив XYNC + USD/EUR/RUB/BTC/USDT);
- `src/pages/Web3Page/ImportWallet.tsx` — подсказка формата ключа.

Проект xma после правок тайпчекается начисто (`tsc --noEmit` → 0 ошибок).
Ноду для адаптера задают `VITE_XYNC_NODE` и `VITE_XYNC_EXPLORER`.

## Структура

```
explorer/
├── index.html
├── vite.config.ts        # dev-прокси /n1../n4 → api-ноды (решает CORS)
└── src/
    ├── codec.ts          # кодек + ed25519 (порт codec.py/crypto.py)
    ├── api.ts            # клиент api-ноды + WebSocket /events
    ├── format.ts         # суммы/курсы/время (целочисленно, без float в значениях)
    ├── store.ts          # состояние: нода, валюты, статус, чекпоинты, кошелёк
    ├── wallet.ts         # провайдеры подписи + все операции
    ├── panels.ts         # read-панели
    ├── walletui.ts       # UI кошелька и формы операций
    ├── ui.ts / styles.css
    └── main.ts           # раскладка, hash-роутинг, авто-обновление
```

Маршруты: `#/<вкладка>`, `#/account/<idx>`, `#/pub/<pubkey>`, `#/tx/<id>`.

### nginx для продакшна (пример)

```nginx
location /n1/ { proxy_pass http://api-node-1:7105/; proxy_http_version 1.1;
                proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }
location /    { root /var/www/xync-explorer/dist; try_files $uri /index.html; }
```
