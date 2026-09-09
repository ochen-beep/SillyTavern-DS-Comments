# PROJECT_MAP — DS Comments

> Карта репозитория для работы агента/разработчика. Обновлять при существенных изменениях.
> Разведка: **2026-09-09** · Расширение **v0.10.0** (`manifest.json:8`) · `minimum_client_version: 1.18.0` (`manifest.json:11`)
> Проверено: `npm test` — **549 pass / 0 fail** (node --test, ~0.8 с, NODE_TEST=1). Незакоммиченный diff: `src/prompt-contract.js` + 2 теста (замена плейсхолдеров в JSON-примере контракта на реальный текст — см. §6).
> Deep-dive документы: `docs/deep-dive-prompt-system.md` (система промптов: вайб/контракт/сборка/отправка, 2026-09-09).
> Реализовано 2026-09-09: выбор шаблона больше не сбрасывается сам (фолбэки без персиста, `cc6bc75`); тексты шаблонов перенесены из localforage в extensionSettings + миграция (`a88dc9f`); onClean чистит новое хранилище (`b0e12b3`).

## 1. Назначение

SillyTavern-расширение: генерирует «дискорд-ленту» комментариев зрителей к сцене чата **отдельным LLM-запросом**. Сам чат, свайпы и текст сообщений никогда не изменяются (README:4–5). Фид хранится per-сообщение **и per-свайп**; два режима хранения: серверный файл на чат (saveMode) или локальный noSave-режим. Русский вайб-промпт на макросах `{{random::}}` (`chat-styles/main.md`).

## 2. Точки входа и жизненный цикл

- `manifest.json` — `js: index.js`, `css: style.css`, `i18n: src/i18n/ru-ru.json`, **hooks**: update/enable/disable/activate/clean → одноимённые экспорты `index.js`.
- `index.js` — единственная точка входа: хуки (`index.js:73-131`), `init()` (`index.js:187-317`), оркестрация панели/лаунчера, биндинг настроек, slash/debug регистрации, cleanup (`index.js:963-984`).
- `onClean` (`index.js:93-131`): последовательность «отменить генерацию → удалить серверные файлы звуков → удалить localforage-ключи (параллельно, `Promise.allSettled`, т.к. ST гоняет хуки с таймаутом 5 c)».

## 3. Структура файлов (роли)

| Файл | Роль |
|---|---|
| `src/core.js` | Константы (MODULE_NAME, META_KEY, LF_*-ключи localforage), `defaultSettings`/`state` (`core.js:35-118`), настройки-персист (extensionSettings, `core.js:370-436`), API-ключ в localforage (`core.js:671-701`), epoch-гард (`core.js:162-182`), sanitize через DOMPurify с FORBID media/link (`core.js:277-304`), попапы через `ctx.Popup` (`core.js:704-737`), debug/restore-пробы, `collectRuntimeInfo` (`core.js:531-641`) |
| `src/events.js` | Все подписки на eventSource: CHAT_CHANGED, CHARACTER_MESSAGE_RENDERED (единственный триггер генерации, `events.js:460-514`), MESSAGE_SWIPED/DELETED/SWIPE_DELETED/EDITED, CHAT_RENAMED, WORLD_INFO_ACTIVATED (pending-stash → claim при рендере, `events.js:648-679`), CONNECTION_PROFILE_UPDATED (`events.js:690-703`). Плюс scroll-обсервер по `#chat` (IntersectionObserver + MutationObserver, скролл только восстанавливает кэш, никогда не генерирует) |
| `src/generator.js` | `generateFeed` (`generator.js:407-713`): целевой пост/свайп → вайб (localforage → `chat-styles/*.md`) → fingerprint → кэш → лор → сборка промпта (contract+vibe, отдельные user-сообщения, `generator.js:206-251`) → API → parse → render → store. Фазовые тайминги + stale-журнал в event-log |
| `src/connection.js` | Источник «профиль»: `ConnectionManagerRequestService.sendRequest` (`connection.js:137-140`), normalize ошибок abort (`connection.js:141-151`), `extractTextFromResponse` для 4 форм ответов (`connection.js:167-196`). Источник «custom»: OpenAI-совместимый fetch с CORS-оговоркой, классификация URL, подтверждение insecure HTTP per-origin (`connection.js:229-287`), таймаут 5 мин, debug-слот `lastCustomEndpointDebug` |
| `src/parser.js` | JSON-парсер с починкой: strip `<think>`, BOM, ```-заборы → 4 эскалации (direct → repair → извлечение `{…}` по одному → обрезанный хвост) (`parser.js:213-321`) |
| `src/renderer.js` | Сообщения ленты: hash-hue градиентные ники, reply-бар, реакции, mini-markdown; sanitize до/после |
| `src/prompt-contract.js` | НЕИЗМЕНЯЕМЫЙ контракт промпта (JSON-формат для парсера) в коде; редактируемый «вайб» — в `chat-styles/*.md`/localforage |
| `src/cache.js` | Mode-agnostic адаптер фида: `storeFeed`/`clearFeed`/`getCurrentFeed`/`showCurrentFeed` (`cache.js:474-576`), `selectCommentaryTarget` (суперсеед-гарды: sequence + chatId + epoch, `cache.js:89-189`), `resolvePreferredCommentaryTarget` (лучший видимый пост DOM → state → последний AI, `cache.js:275-313`), индикатор `#dscIndicator` |
| `src/feed-file-store.js` | **saveMode-хранилище**: один JSON на чат на сервере `data/<user>/user/files/dsc_<guid>.json`; ключ записи = `send_date` свайп-слота (`feed-file-store.js:399-410`); in-memory зеркало + сериализованная цепочка upload (`schedulePersist`, `feed-file-store.js:355-377`); guid и fork-маркеры в `chatMetadata[META_KEY]`; форк/чекпоинт-изоляция (`feed-file-store.js:134-158`); миграция v1 (chatMetadata.posts → файл, `feed-file-store.js:582-635`); GC по живым слотам |
| `src/pinned-store.js` | **noSave-хранилище**: `state.pinnedFeeds` (Map chatId→feed) → localforage `LF_PINNED`; немедленные записи через promise-chain, LRU 32 чата |
| `src/lorebooks.js` | Per-chat конфиг лора в `chatMetadata['dscomments_lorebook']`; manual (точечные uid) и automatic (dry-run `getWorldInfoPrompt` **всегда isDryRun=true** + векторные записи из WORLD_INFO_ACTIVATED-cache, привязанного к якорю) (`lorebooks.js:352-402`); fingerprint-контракт autoScope (`lorebooks.js:103-111`) |
| `src/sound.js` | Звук: builtin из `sounds/`, кастомные — серверно (`dsc_sound_custom_N.<ext>` через user-files), миграция старых blob'ов из localforage |
| `src/user-files.js` | Обёртки официального files-API ST: `/api/files/upload`, `/api/files/delete`, `/api/files/verify`, `GET /user/files/<name>` |
| `src/event-log.js` | Персист-лог значимых событий в localforage (переживает F5), 150 записей, session-id |
| `src/diagnostic-dump.js` | Сборка JSON-дампа (metadata-only) |
| `src/lifecycle.js` | DI-реестр для разрыва циклов cache↔index, quickmenu↔index; `createInitializationController` (сериализация init, `lifecycle.js:25-63`); `onNoSaveModeChanged` |
| `src/registration-lifecycle.js` | Регистрация slash-команды и debug-функций **один раз на страницу**, пережив enable/disable |
| `src/slash-commands.js` | Плоская команда `/dscomments <toggle|regenerate|clear>` (ST 1.18.0 без `subcommands` — комментарий `slash-commands.js:3-12`) |
| `src/ui/window.js` | Панель `#dscWindow` на body: mount, drag/resize, мобильный полноэкранный режим, измерение ST-хрома (`--dsc-st-top/bottom`), viewport-sync |
| `src/ui/feed-controller.js` | Единственный владелец `#dscFeed`: showFeedHtml c dedup по **санитизированной** форме + отложенный scroll-reset |
| `src/ui/chrome.js` | Шапка: реген-кнопка (abort при повторе), ⚙, Aa, статус-оверлей `setStatus` |
| `src/ui/quickmenu.js` | Меню ⚙: степпер постов, селектор, тумблеры autoupdate/noSave/sound |
| `src/ui/typography.js` | Поповер шрифта (размер/семейство) |
| `src/ui/feed-gestures.js` | Жесты: overscroll-пулл (посты), горизонтальный свайп (свайпы, только локальный restore), колесо с dwell-gate; один AbortController на все слушатели |
| `src/ui/floating-launcher.js` | FAB `#dsc_fab`, позиция в localStorage, clamp под `#top-bar` |
| `src/ui/lorebook-picker.js` | Контроллер выбора книг/записей лора; подписка на WORLDINFO_UPDATED |
| `src/ui/settings-sync.js` | FIELD_MAP (id поля → проп сеттинга, `settings-sync.js:12-37`), синк DOM↔state, шаблоны промптов (edit-on-place в extensionSettings `promptTemplates`, builtin `main` защищён; миграция из localforage `migrateTemplatesFromLocalforage`), populate профилей |
| `src/ui/theme-sync.js` | Непрозрачный фон из `--SmartThemeBlurTintColor`: MutationObserver на style `<html>`, токены `--dsc-bg/--dsc-overlay-bg` |
| `src/ui/dom-ready.js` | `whenSendFormReady` — APP_READY вместо polling, возвращает disposer |
| `src/ui/st-swipe-bridge.js` | **Отложено**: no-op стаб двусторонней мутации свайпов ST (сохранён как шов для будущего флага) |
| `src/ui/empty.js`, `icons.js`, `window-geometry.js` | Пустые состояния (CTA), inline SVG (без `<use>` — DOMPurify его режет), клампинг геометрии |
| `settings.html` | Скелет панели настроек (рендер через `ctx.renderExtensionTemplateAsync('third-party/<FOLDER_NAME>', 'settings')`, `index.js:220`) |
| `style.css` | Токены от `--SmartTheme*`, `#dscWindow` z-2998, FAB z-2999, ниже ST-хрома (3000/3005); `@supports` relative-color фолбэк |
| `chat-styles/main.md` | Вайб «фандомные комментарии» на `{{random::}}` |
| `test/` (39 файлов, 549 тестов), `test-helpers/`, `scripts/run-tests.mjs` | node:test, NODE_TEST=1 открывает `_test*`-экспорты; CI: `.github/workflows/tests.yml` |

## 4. Интеграции с SillyTavern

**События (eventSource.on)** — `events.js:402-706`: CHAT_CHANGED, CHARACTER_MESSAGE_RENDERED, MESSAGE_SWIPED, MESSAGE_DELETED*, MESSAGE_SWIPE_DELETED*, MESSAGE_EDITED/UPDATED, CHAT_RENAMED*, WORLD_INFO_ACTIVATED, CONNECTION_PROFILE_UPDATED; APP_READY (`dom-ready.js:33`); WORLDINFO_UPDATED (`lorebook-picker.js:451-459`). (* — guarded наличием.)

**UI-инъекции**: панель `#dscWindow` и FAB `#dsc_fab` на `document.body`; лаунчер-кнопка в `#send_form → #qr--bar → .qr--buttons` (index.js:406-421; при отсутствии QR-бара остаётся FAB); настройки в `#extensions_settings`; поповеры/меню на body; CSS-переменные `--dsc-st-top/bottom` на `<html>`; тема через MutationObserver на style html. Селекторы ST, от которых всё держится: `#chat` (скроллер, `events.js:288-296`), `[mesid]`, `#send_form`, `#top-bar`, `#extensions_settings`, `--SmartTheme*`, `--topBarBlockSize`.

**Slash/debug**: `/dscomments` (flat) через `SlashCommandParser.addCommandObject`; 8 debug-функций через `ctx.registerDebugFunction` (index.js:820-913) — очистка/инфо кэша, лог кастомного эндпоинта, pinned-фиды, restore/дебаг логи.

**Popup**: `ctx.Popup.show.confirm/input` + `ctx.POPUP_RESULT` с фолбэком на `window.confirm/prompt` (core.js:704-737).

**Библиотеки ST**: `SillyTavern.libs.lodash` (debounce, cloneDeep/merge), `SillyTavern.libs.DOMPurify`, `SillyTavern.libs.localforage` — доступ через глобал `SillyTavern`.

## 5. Хранение: где что лежит и когда пишется

| Данные | Где | Когда пишется |
|---|---|---|
| Настройки расширения | `ctx.extensionSettings['dscomments']` | `saveSettings()` → `ctx.saveSettingsDebounced()` (каждое изменение UI); flush на page-hide (`index.js:917-928`) |
| API-ключ custom | localforage `DSComments_apiKey` | debounce 400 мс; flush на blur/page-hide (core.js:681-701) |
| Вайб-шаблоны пользователей | `extensionSettings.dscomments.promptTemplates` `{имя: текст}` (серверные настройки; до 2026-09-09 — localforage) | по кнопке Save/Create/Delete/Reset + одноразовая миграция из localforage в init (settings-sync.js) |
| Фид saveMode | серверный файл `dsc_<guid>.json` (user-files API) | каждая мутация зеркала → сериализованный upload; guid + fork-маркеры → `chatMetadata.dscomments_commentary` через `saveMetadata` |
| Фид noSave | localforage `DSComments_pinned` (LRU 32) | немедленно после каждой мутации (pinned-store.js:151-166) |
| Конфиг лора | `chatMetadata['dscomments_lorebook']` | на каждое изменение пикера (lorebooks.js:125-144) |
| Звук: метаданные/файл | settings `soundFiles{name,file}` / сервер `dsc_sound_*.<ext>` | upload сразу при выборе файла; rollback при неудаче (sound.js:125-162) |
| Event-log | localforage `DSComments_eventlog` | debounce 500 мс; flush page-hide |
| Позиция FAB | localStorage `dsc_fab_position` | на отпускание после drag |
| Геометрия окна | settings `windowGeom` | на конец drag/resize (window.js:89-99) |

**Поток данных (генерация, saveMode)**: CHARACTER_MESSAGE_RENDERED → fp-проверка кэша → `generateFeed` → лор (dry-run WI + event-cache) → промпт = `PROMPT_CONTRACT` + вайб (`buildPrompt`, `{{count}}` до `substituteParams`) → `ConnectionManagerRequestService.sendRequest` или fetch custom → `parseCommentary` (JSON repair) → `renderMessages` (DOMPurify) → epoch-check → `setFeedText` → `storeFeed` → `setFeedSlot` (ключ=send_date слота) → цепочка `uploadUserFile` → `data/<user>/user/files/dsc_<guid>.json`. Восстановление: CHAT_CHANGED/scroll/swipe/gesture → `selectCommentaryTarget` (fp-сверка, soft-stale показывает кэш с пометкой).

## 6. Состояние: находки, риски, несоответствия (наблюдения, ничего не правим)

1. **Незакоммиченный diff**: `src/prompt-contract.js` — плейсхолдеры «reply text here» заменены реальными фразами (модели копировали пример дословно; коммент в тесте ссылается на дамп 2026-09-08, gemini-3.1-pro) + усилены тесты (`test/contract.test.mjs`, `test/prompt-contract.test.mjs`). Тесты зелёные. Не закоммичено.
2. **Мёртвый (production) код**: `restoreCachedCommentary` (`cache.js:315-323`) — в проде (`src/` + `index.js`) вызовов нет, только тесты (`test/cache.test.mjs`); `dropSlotEntry` (`feed-file-store.js:523-535`) — аналогично, только тесты (продуктовый путь MESSAGE_SWIPE_DELETED идёт через `pruneOrphanedEntries`, `events.js:596-611`). `st-swipe-bridge.js` — задокументированный отложенный стаб (не мусор, но мёртв на горячем пути).
3. **Дубль версии**: `settings.html:215` хардкод «DS Comments v0.10.0» синхронен `manifest.json:8`, но при следующем bump легко разойдётся (нет теста/генерации).
4. **Доступ к внутренностям ST**: `connection.js:29` фолбэк на `window.extension_settings` (глобал ST-ядра) — противоречит собственному правилу проекта «только ctx-поверхность» (комментарий core.js:707-710); плюс зависимость от текста ошибки CM (`'API request failed'` + `e.cause`, `connection.js:141-151`).
5. **Page-hide не ждёт цепочку загрузок фида**: `onVisibilityChange` (index.js:917-928) делает flushSettings/apiKey/pinned/eventLog + saveMetadata, но **не** `flushFeedStoreWrites()` — незавершённый upload на закрытие вкладки теряет последнюю мутацию фида (запись будет потеряна до следующей мутации). На десктопе fetch обычно доезжает; на мобиле — неизвестно, не проверено.
6. **Русский фолбэк в английской базе**: `settings.html:177` `<span data-i18n="dscomments.settings.role">Роль</span>` — у всех соседей фолбэк английский.
7. **Хрупкие к ST-апдейту места**: контракты `send_date` слотов как ключей (feed-file-store.js:399-410 — завязка на то, что ST держит send_date стабильным и уникальным per-swipe); схема профилей CM и `ConnectionManagerRequestService` (частный сервис, не задокументированный как публичный API); `SillyTavern.libs.*`; z-index 2998/2999 vs ST 3000/3005; `#chat` как единственный скроллер; manifest `hooks`/`i18n`/`minimum_client_version` — поверхность 1.18.x.
8. **Паттерн экспандо-свойств на DOM** (`bar._dscHideTimer`, `feed._dscLastHtml`, `header._dragBound` и т.п.) — работает, но неочевиден; единый стиль не зафиксирован.

### Находки deep-dive системы промптов (2026-09-09, детали в docs/deep-dive-prompt-system.md)

9. **`includeUser` (`core.js:58`) — мёртвое поле** дефолтов: читателей нет (реальная — `includePersona`).
10. **Дублированный резолв вайба**: `settings-sync.loadPromptContent` и `generator.loadStylePrompt` — две реализации с независимыми builtin-кэшами (`settings-sync.js:289`, `generator.js:23`); фолбэк на 'main' есть только в генераторе.
11. **fp-кэш пречека не учитывает текст шаблона** (`_fpSettingsKey`, `generator.js:350-357` — только имя): правка контента без смены имени до ближайшего CHAT_CHANGED может отдать фид со старым вайбом; ручная регенерация честная.
12. **Молчаливые отказы записи шаблонов**: обработчики Save/Create/Reset/Delete (`index.js:645,654,664,674`) await без catch — ошибка localforage = unhandled rejection без тоста. Reset при недоступном `main.md` показывает ложный успех (`settings-sync.js:351` молчит, тост в `index.js:664-666` всё равно success).
13. **Асимметрия валидации**: Save отказывает на пустой шаблон (`index.js:633-636`), Create — нет (`index.js:654`); пустой юзер-шаблон легитимен в редакторе (hasOwn) но валит генерацию (`generator.js:490`).
14. **`max_tokens` не задаётся** ни в CM-профиле (`connection.js:138`), ни в custom-body (`connection.js:327`) — длина ответа на усмотрение бекенда; риск обрезанного JSON при больших count (открытый вопрос №1 в deep-dive §7).
15. **РЕШЕНО (2026-09-09):** самосброс выбора шаблона на 'main' (воспроизведён скриптом, deep-dive §8): тексты шаблонов — localforage (браузер×origin), имя выбранного — серверные настройки; два авто-фолбэка (`settings-sync.js:390-396` при каждой загрузке страницы через `renderPanel`→`syncPanelVisibility` и `generator.js:57-63` при генерации) при «повисшем» имени молча переписывали выбор на 'main' И ПЕРСИСТИЛИ (теперь: фолбэки без записи, видимое «не найден», транзиентный main — `cc6bc75`). Триггеры повисания устранены переносом текстов в настройки (`a88dc9f`). Исторические триггеры: другой браузер/устройство, другой origin (localhost≠127.0.0.1≠LAN-IP), хук `clean` ST (ручная кнопка «Clean extension data» / удаление с очисткой — `index.js:124-130` стирает LF_PROMPTS целиком), эвикция хранилища. F5/рестарт сервера НЕ сбрасывают. Тестов на фолбэки нет.
16. **Сверка с доками ST** (deep-dive §8.1): «Don't store large data in extensionSettings» (SillyTavern-Docs, Writing-Extensions, Performance) — их пример «large» = мегабайты; наши вайбы — единицы КБ (main.md 4.6 КБ, jailbreakText 864 симв.), ядро само хранит в extension_settings regex-скрипты и QR-наборы → перенос текстов шаблонов в extensionSettings докам НЕ противоречит (нужен мягкий лимит размера); фиды/звуки/ключ уже вынесены правильно. Фикс: варианты A (extensionSettings) / B (серверный файл через user-files), в любом — убрать персист из фолбэков.

### Сравнение с открытыми расширениями (проверено по исходникам)

- **SillyTavern Connection Manager (ядро ST)** — [connection-manager/index.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/connection-manager/index.js): тот же `ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, {stream, signal, extractData, includePreset})`, что в `connection.js:137-140`; их `/profile-genstream` — ближайший официальный аналог «вторичного запроса». DS корректно передаёт массив сообщений и использует `extractData:true`; отличие — DS всегда non-streaming и нормализует abort из `e.cause`.
- **muyoou/st-memory-enhancement** (популярное стороннее) — [репозиторий](https://github.com/muyoou/st-memory-enhancement): per-сообщение/per-свайп данные хранит **внутри чата** (маркеры `<tableEdit>` в `chat.swipes[swipe_id]`, `chat.swipe_info`). DS сознательно выносит фид из чата в серверный файл с ключом `send_date` — чище (чт-v1-миграция, chat не пухнет), но сильнее зависит от стабильности `send_date` (см. риск №1 в §7).
- **Ядро ST «Summarize» (memory)** — [memory/index.js](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/extensions/memory/index.js): вторичный LLM-запрос через `quietPrompt`, кэш результата в `mes.extra.memory` (внутри сообщения). DS вместо этого — `generationFp` (хэш всех входов генерации) поверх серверного стора; подход строже (fp меняется → регенерация, а не показ устаревшего), но сложнее.

## 7. Топ-5 рисков (мои кандидаты)

1. **Ключ фида = `send_date` слота** (`feed-file-store.js:399-449`): если ST сменит формат/семантику send_date или появятся дубли (копирование сообщений), записи мисматчатся; спасает только fp-скан (линейный). Сценарий: апдейт ST + старые чаты → «комментарии пропали».
2. **Связка с Connection Manager** (`connection.js:19-34, 99-151`, `events.js:690-703`): непубличный сервис и схема профилей; переименование/смена обёртки ошибок в ST ломает генерацию «профилем» и дропдаун настроек.
3. **DOM-контракты с ядром ST** (`events.js:288-296` `#chat`-скроллер; `#mesid`; `#send_form`/`#qr--bar`; z-index): рефактор UI ST или QR-расширения → лаунчер/скролл-следование молча умирают (частично защищено FAB).
4. **`SillyTavern.libs.*` и manifest-поверхность 1.18** (core.js:239, 290, 674; manifest.json:11-21): исчезновение/переименование libs роняет импорт всего расширения; hooks/i18n в манифесте — новая поверхность, поведение на будущих версиях не гарантировано.
5. **Разрастание диагностического слоя**: три параллельных лога (debug ring `core.js:187-223`, restore-probe `core.js:465-524`, event-log `event-log.js`) + `lastCustomEndpointDebug` — поддерживать три поверхности дороже, чем одну; риск путаницы при отладке и утечки контекста при включённом debugMode (полные тела промптов в памяти, `connection.js:330-345` — by design, но помним).
