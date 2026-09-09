# Deep dive: система создания и сохранения промптов (DS Comments)

> Разбор по шаблону st-03. Дата: 2026-09-09 · Расширение v0.10.0.
> Скоуп: **вайб-шаблоны** (создание/редактирование/хранение), **неизменяемый контракт**,
> **сборка финального промпта** и его **отправка в LLM**, плюс связка с кэшем через
> generation-fingerprint. Парсер и хранилище фидов — за пределами скоупа (см.
> PROJECT_MAP.md §3), упоминаются только на стыках.

## 0. Архитектура в двух абзацах

У промпта две части с разным статусом. **Контракт** — жёсткая шапка с JSON-схемой
ответа, живёт только в коде (`src/prompt-contract.js:14-40`), в редакторе не видна и
юзером непереназначаемая — ломать парсер из UI невозможно. **Вайб** — редактируемый
стиль (`chat-styles/main.md` builtin + копии пользователей), живёт в localforage
`DSComments_prompts` одним объектом `{имя: текст}`.

Склейка и отправка: `контракт + '\n\n' + вайб → {{count}} → substituteParams` →
это `systemPrompt`; персона/карточка/лор/история сцены — отдельные `user`-сообщения;
опциональный jailbreak — в позицию system/user/assistant-prefill. Текст вайба входит
в generation-fingerprint, поэтому правка шаблона меняет «отпечаток» и делает старые
кэшированные фиды несовпадающими (после пересчёта fp — см. §5.2 об оттенке).

## 1. Точки входа

### 1.1 Создание/редактирование (UI настроек)

| Точка | Где |
|---|---|
| Разметка секции Prompt (select, Create, textarea, Save, Reset, Delete) | `settings.html:148-170` (select `dsc_template`:156, `dsc_template_create`:157, textarea `dsc_template_text`:162, `dsc_template_save`:164, `dsc_template_reset`:165, `dsc_template_del`:166) |
| Клик-биндинги кнопок | `index.js:524-527` |
| Смена шаблона в select (change) | `index.js:560-565` → `state.settings.promptTemplate` + `saveSettings()` + `syncPromptEditor()` |
| `handleTemplateSave` | `index.js:627-647` |
| `handleTemplateCreate` | `index.js:649-657` |
| `handleTemplateReset` | `index.js:659-667` |
| `handleTemplateDel` | `index.js:669-677` |
| Модалки confirm/input (ST Popup с фолбэком на window.confirm/prompt) | `core.js:704-737` |
| textarea НЕ автосохраняется (input-событие пропускается) | `index.js:611-614` |
| Первичная отрисовка редактора: `syncPanelVisibility` → `syncPromptEditor` | `settings-sync.js:120-128` (вызовы из `index.js:371,387,395,478`; `syncSettingsSections` в index.js — это алиас `syncPanelVisibility`, `index.js:38`) |

### 1.2 Хранение/чтение шаблонов (модульный слой)

| Операция | Где |
|---|---|
| `LF_PROMPTS = 'DSComments_prompts'` | `core.js:21` |
| `loadPromptContent(name)` — localforage (hasOwn) → builtin fetch + кэш `_builtinCache` | `settings-sync.js:289-309` |
| `savePromptContent` / `savePromptAs` / `deletePrompt` / `resetPromptToBuiltin` / `listTemplateNames` | `settings-sync.js:311-358` |
| `syncPromptEditor` — dropdown + textarea + состояния кнопок, monotonic-request guard | `settings-sync.js:362-405` |
| Имя активного шаблона: `defaultSettings.promptTemplate = 'main'` | `core.js:64` (персист через `saveSettings` → `ctx.extensionSettings`, `core.js:370-375`) |

### 1.3 Сборка и отправка (генерационный путь)

| Шаг | Где |
|---|---|
| `loadStylePrompt` — резолв вайба для генерации (localforage → builtin кэш → fetch → фолбэк 'main' с персистом) | `generator.js:35-66` |
| `PROMPT_CONTRACT` | `prompt-contract.js:14-40` |
| `buildPrompt(vibe, {count, contract})` — glue + `{{count}}` + `resolveSTMacro` | `core.js:323-328`; `resolveSTMacro`: `core.js:307-312` |
| Контекстные блоки: `buildContextParts` (persona/character/lore), `buildChatHistoryParts` ([Previously]/[Current chapter]) | `generator.js:103-124`, `154-175`; текст якорного свайпа — `readSwipeText`: `generator.js:138-144` |
| `assembleCompletePrompt` — collects all + jailbreak | `generator.js:227-251` |
| `assemblePrompt` — split на user-сообщения + роли jailbreak | `generator.js:206-225` |
| Fingerprint: `buildCurrentFingerprintInput` / `getCurrentGenerationFingerprint` / `_fpSettingsKey` | `generator.js:293-357` |
| Fingerprint-контракт: `buildGenerationFingerprintInput` / `buildGenerationFingerprint` (`v1-<hash>`) | `lorebooks.js:432-490` |
| Отправка: `callGenerationAPI` → профиль (CM) / custom fetch | `generator.js:258-271`; `connection.js:90-165`; `connection.js:311+` |
| Debug-лог полного промпта (только при debugMode) | `connection.js:330-345` |
| Slash `/dscomments regenerate` идёт в тот же `generateFeed` | `src/slash-commands.js` → `generator.js:407` |

## 2. Поток данных

### 2.1 Создание/сохранение шаблона (UI)

```
textarea (правки, НЕ автосейв: index.js:611-614)
  ├─ Save:      если cur='main' → showInputModal('main_copy') → savePromptAs(name, text)
  │             иначе savePromptContent(cur, text)               index.js:627-647
  ├─ Create:    showInputModal(`${cur}_copy`) → savePromptAs(name, text[пустой OK])  index.js:649-657
  ├─ Reset:     confirm → resetPromptToBuiltin() — перезаписать юзер-шаблон текстом builtin main  index.js:659-667, settings-sync.js:347-353
  ├─ Delete:    confirm → deletePrompt(); если удалили активный → promptTemplate='main' + saveSettings  index.js:669-677, settings-sync.js:330-340
  └─ select change → promptTemplate=value + saveSettings + syncPromptEditor (правки теряются молча)  index.js:560-565

savePromptAs: имя запрещено='main' (isBuiltinTemplate) → localforage LF_PROMPTS (весь объект read-modify-write)
              → promptTemplate=newName → saveSettings() → syncPromptEditor()  settings-sync.js:317-328
```

Хранилище после операций: localforage `DSComments_prompts` = `{ '<имя>': '<текст вайба>' }`
(контракт туда не попадает никогда); имя активного — в `extensionSettings.dscomments.promptTemplate`.

### 2.2 Сборка финального промпта (генерация)

```
generateFeed (generator.js:407)
  1. loadStylePrompt(): localforage[hasOwn] → _builtinPromptCache → fetch chat-styles/<name>.md
     404 и name≠'main' → promptTemplate='main' + saveSettings + рекурсия    generator.js:35-66
  2. fp = hash(loreConfig, toggles, promptTemplate(имя), stylePrompt(сырой текст),
     userCount, jailbreak(raw), apiSource, profileId/endpoint/model, profileApi/Model)
     generator.js:293-304 → lorebooks.js:432-490
  3. кэш-проверка (saveMode, !force): getCachedPost(msgId, swipe, fp)        generator.js:504-517
  4. лор (по конфигу чата) → lore.text
  5. assembleCompletePrompt (generator.js:227-251):
       systemPrompt = buildPrompt(vibe, {count: userCount, contract: PROMPT_CONTRACT})
         = contract + '\n\n' + vibe → заменить все {{count}} → ctx.substituteParams
         (generator.js:235: parseInt(userCount)||5; clamp 1..100: core.js:332)
       jailbreak = resolveSTMacro(trim(jailbreakText)) — только если enableJailbreakBlock
  6. assemblePrompt (generator.js:206-225):
       userMessages = [persona?, character?, lore?, [Previously…?]?, [Current chapter…]]
       .filter(Boolean); если пусто → ['Generate the commentary now.']
       jailbreakRole: 'user' → prepend к userMessages[0]; 'assistant' → assistantPrefill;
       иначе → дописать к systemPrompt
  7. transport: messages = [{system}, ...user, (assistant prefill)] →
       профиль: ConnectionManagerRequestService.sendRequest(profileId, messages, undefined,
         {stream:false, extractData:true, includePreset:false, includeInstruct:false})
         (connection.js:129-140; max_tokens НЕ задаётся)
       custom: то же тело в fetch на OpenAI-совместимый endpoint, model опционален
         (connection.js:322-328)
  8. ответ → extractTextFromResponse (4 формы, connection.js:167-196) → parseCommentary
```

Рендер/кэширование результата — вне скоупа (PROJECT_MAP §5 «Поток данных»).

## 3. Контракт с SillyTavern

- **`ctx.substituteParams`** (`core.js:307-312`): единственная точка входа ST-макросов.
  Обрабатывает весь systemPrompt (контракт+вайб) и jailbreak. `{{count}}` заменяется ДО
  него (`core.js:323-328`), поэтому ST его никогда не видит. `{{random::}}` в вайбе
  разрешается здесь же, на этапе сборки — один розыгрыш на одну генерацию.
- **`ctx.Popup.show.confirm/input` + `POPUP_RESULT`** — модалки имени/подтверждений,
  фолбэк `window.confirm/prompt` (`core.js:704-737`).
- **`ctx.extensionSettings['dscomments']` + `saveSettingsDebounced`** — только имя
  активного шаблона и jailbreak-настройки; сами тексты шаблонов в ST-настройки не пишутся.
- **`SillyTavern.libs.localforage`** — хранилище шаблонов (`settings-sync.js:295,312,314`).
- **Статика расширения**: builtin вайб — `fetch(BASE_URL + '/chat-styles/<name>.md')`
  (`settings-sync.js:303`, `generator.js:50`); в chat-styles ровно один файл — `main.md`.
- **`ConnectionManagerRequestService.sendRequest`** — массив messages уходит as-is
  (chat-completion); trailing assistant = prefill (`connection.js:122-133`). Поверхность
  1.18, непубличный сервис (риск №2 в PROJECT_MAP §7).
- **CHAT_CHANGED / свайпы / регенерация**: снапшот epoch в начале `generateFeed`, проверки
  после каждого await (`generator.js:485,495,569,606,629`, catch: 645) — промпт,
  собранный для старого чата, не уедет в рендер нового. Якорь берёт текст конкретного
  свайпа через `readSwipeText` (`generator.js:138-144`), а не активный `mes`. Стриминга
  нет вообще (`stream:false`, `connection.js:139,327`) — промежуточных состояний промпта
  не существует. Групповой чат: имена из `m.name`/`ctx.name1` (`generator.js:75,164`),
  отдельной ветки нет.

## 4. Крайние случаи: что произойдёт сейчас

| # | Случай | Что сейчас произойдёт |
|---|---|---|
| 1 | Пустой текст шаблона | **Save** отказывает с тостом (`index.js:633-636`); **Create** — разрешает (`index.js:654` не проверяет). Пустой шаблон при генерации: `loadStylePrompt` вернёт `''` (hasOwn-чтение, `generator.js:44`) → throw «Prompt template could not be loaded» (`generator.js:490`) → оверлей ошибки в фиде |
| 2 | `promptTemplate` указывает на несуществующее имя (удалили в другом табе / ручная правка JSON) | Генератор: fetch 404 → персист-фолбэк на 'main' (`generator.js:57-63`). Редактор: syncPromptEditor выберет первый пункт и персистнет (`settings-sync.js:392-396`) |
| 3 | localforage недоступен (квота/приватный режим) | Чтение: catch → fallthrough на builtin (`generator.js:40-45`). **Запись: `savePromptContent` бросает → обработчики await без try/catch → unhandled rejection, тоста нет, юзер думает что сохранилось** (`index.js:645,654,664,674`) |
| 4 | Очень длинный вайб/лор/история | Никакой обрезки; целиком в промпт. `max_tokens` не задаётся ни профилем (3-й аргумент `undefined`, `connection.js:138`), ни custom-body (`connection.js:327`) → длина ответа на усмотрение бекенда; при count→100 риск обрезанного JSON → parse fail |
| 5 | `{{count}}` в пользовательском вайбе | Тоже заменится — замена глобальная по всему systemPrompt, escape-механизма нет (`core.js:326`) |
| 6 | Неизвестный/служебный макрос в вайбе | substituteParams оставляет как есть либо подставляет своё ({{user}}, {{char}} и т.п.) — резолв один на генерацию (`core.js:307-312`) |
| 7 | Правка ТЕКСТА шаблона без смены имени | `_fpSettingsKey` содержит только имя (`generator.js:350-357`) → кэш fp пречека (`generator.js:323-333`) живёт до ближайшего CHAT_CHANGED → авто-рестор может показать фид со СТАРЫМ вайбом как валидный. Ручная регенерация пересобирает fp честно (`generator.js:493`) |
| 8 | Два таба ST одновременно | LF_PROMPTS — цельный объект, read-modify-write (`settings-sync.js:311-315`) → сохранение двух разных шаблонов в двух табах = last-write-wins, одна правка теряется молча |
| 9 | Смена чата посреди сборки промпта | epoch-гарды: сборка после await проверяется (`generator.js:569-573`), результат выбрасывается, `generation_stale` в event-log |
| 10 | Save/Create под существующим именем юзер-шаблона | Молча перезапись (edit-on-place by design, `settings-sync.js:317-328`); имя 'main' отклонено (`settings-sync.js:323`) |
| 11 | Джейлбрейк/вайб с `{{user}}`/`{{char}}` | В fp — сырой текст (`lorebooks.js:452,448`), в промпт — резолвнутый → смена персонажа при том же fp может отдать кэш с чужим резолвом (для `{{random::}}` это осознанно, для {{char}} — оттенок) |
| 12 | Параллельный вызов generateFeed | `state.generationInProgress` guard — второй вызов молча выходит (`generator.js:409`) |
| 13 | chat-styles/main.md недоступен (сервер отдал 404/оффлайн) | Редактор: пустая textarea без ошибки (`settings-sync.js:308` возвращает ''). Генератор: '' → throw `generator.js:490`. Reset при этом: `resetPromptToBuiltin` молча выйдет (`settings-sync.js:351`), но тост «Vibe reset to main» всё равно покажется (`index.js:664-666`) — ложный успех |
| 14 | Свайп-навигация во время генерации | Промпт уже собран под снапшот (контекст из `getCtx()` на входе, `generator.js:444`); результат пишется в (msgId, swipeIdx), проверенные epoch-гардом — рассинхрона нет |

## 5. Хрупкие места

1. **Дублированный резолв + два кэша builtin.** `settings-sync.loadPromptContent`
   (`settings-sync.js:291-309`) и `generator.loadStylePrompt` (`generator.js:35-66`) —
   две реализации одной логики с независимыми кэшами (`_builtinCache`, `settings-sync.js:289`;
   `_builtinPromptCache`, `generator.js:23`) и уже разным поведением (фолбэк на 'main'
   есть только в генераторе). Любую правку (например инвалидацию кэша) придётся вносить
   в два места.
2. **fp-кэш пречека не знает о тексте шаблона** (крайний №7): неявная зависимость от
   CHAT_CHANGED как точки инвалидации. Лечится дёшево — включить в `_fpSettingsKey`
   хэш контента, но сейчас это не так.
3. **Молчаливые отказы записи.** Все обработчики кнопок `await savePrompt*/deletePrompt/
   resetPrompt*` без catch: ошибка localforage = тишина для юзера (крайний №3). При этом
   create/save дают_success-тост по факту завершения await, т.е. ложный успех возможен
   только в сторону «не сохранилось и не сказали», «сохранилось без сброса» — Reset (№13).
4. **Асимметрия валидации Save/Create** (крайний №1): Create может создать пустой шаблон,
   который легитимно читается редактором (hasOwn, `settings-sync.js:296-298`), но убивает
   генерацию с неочевидной ошибкой «шаблон не загрузился».
5. **Контракт — единая точка ручной синхронизации**: `prompt-contract.js` ↔ `parser.js` ↔
   `contract.test.mjs` (пример обязан парситься) ↔ `prompt-contract.test.mjs` (инварианты
   строки: {{count}}, «JSON array», ключи username/content/reactions/reply, запрет
   placeholder-текста в примере — `prompt-contract.test.mjs:19-63`). Менять контракт
   можно только всеми четырьмя файлами сразу. Тесты держат, но связь — дисциплина, не код.
6. **substituteParams гоняет весь systemPrompt**, включая JSON-пример контракта: если в
   будущей правке контракта/вайба появится текст, совпадающий с макросом ST ({{...}}),
   он будет молча заменён до отправки. Сейчас совпадений нет — держать в голове при
   редактировании.
7. **`includeUser` (`core.js:58`) — мёртвое поле** дефолтов: ни один читатель в src/ и
   index.js (проверено grep), реальная настройка — `includePersona`. Сбивает при чтении.
8. **Assistant-prefill — не универсален**: часть бекендов отвергает trailing assistant
   (собственный комментарий `connection.js:302-305`); при jailbreakRole='assistant' это
   ошибка уровня API, не предупреждающая в UI.

## 6. Что держат тесты

- `test/prompt-contract.test.mjs` (8 тестов): непустота, {{count}}, «JSON array»,
  ключи схемы, FORMAT RULES, наличие примера, запрет placeholder-фраз в примере
  (регрессия gemini-3.1-pro от 2026-09-08).
- `test/contract.test.mjs` (9 тестов): встроенный пример контракта парсится реальным
  `parseCommentary` — главный стоп-кран рассинхрона контракт↔парсер.
- `test/settings-sync.test.mjs` (15 тестов): покрытие CRUD-слоя шаблонов и редактора.
- `test/core.test.mjs`, `test/generator.test.mjs`: buildPrompt/сборка/фазы.

## 7. Пять вопросов, на которые код не отвечает (и как добыть)

1. **Режут ли бекенды ответ при count→100, раз `max_tokens` не задаётся?** Обрезанный
   хвост — это parse fail с общим сообщением. Добыть: эксперимент — userCount=100 на
   2–3 профилях, смотреть `event=generation_api responseChars` / `generation_parse` в
   event-log (`debugMode`), при обрезке — решить, задавать ли max_tokens.
2. **Как реально ведёт себя substituteParams на вайбе, содержащем псевдо-макросы**
   (например `{{random:{{count}}|5}}` — вложенность) — поддерживается ли осознанно?
   Добыть: в консоли ST `SillyTavern.getContext().substituteParams('<строки>')` на
   матрице входов, зафиксировать поведение в тесте-оракул.
3. **Держит ли CM-профиль assistant-prefill на text-completion бекендах** (заявлено в
   комментарии `connection.js:122-133` со ссылкой на ST-внутренности, но на живых
   бекендах не проверено). Добыть: профиль text-completion + jailbreakRole='assistant',
   debugMode → сверить отправленное и ответ.
4. **Живут ли шаблоны в localforage при эвикции хранилища браузером** (IndexedDB
   underline storage может эвиктироваться при переполнении квоты — шаблоны не
   помечены как критичные). Добыть: эксперимент с раздуванием квоты на тестовой
   странице того же origin; продуктово — решить, нужен ли экспорт/импорт шаблонов в файл.
5. **Как часто реальный юзер теряет правки textarea** (переключение шаблона/закрытие
   панели без Save — молча, крайний поток §2.1): нужна ли грязь-индикация или
   автосохранение черновика. Код ответа не даёт; добыть: собственное пользование +
   решение как продуктовое (чердак в localStorage при input — дешёвый вариант).

## 8. Аддендум (2026-09-09): подтверждённый сценарий самосброса выбора на 'main'

> **РЕШЕНО 2026-09-09:** фолбэки без персиста + видимое состояние «не найден» (`cc6bc75`); тексты шаблонов перенесены в extensionSettings с одноразовой миграцией из localforage (`a88dc9f`); onClean стирает новое хранилище (`b0e12b3`). Ниже — разбор исходной проблемы (актуален исторически).

Выбор шаблона **может** сбрасываться на `main` без действия пользователя. Механизм
воспроизведён node-скриптом на реальном `syncPromptEditor` (заглушка localforage без
шаблона, серверные настройки с `promptTemplate: 'my_vibe'`):

```
БЫЛО:  promptTemplate = my_vibe
СТАЛО: state.settings.promptTemplate = main
СТАЛО: сервер (extensionSettings.dscomments.promptTemplate) = main
```

Корень — асимметрия хранилищ: **тексты** шаблонов лежат в localforage/IndexedDB
(браузер × origin, глобально не синхронизируются), а **имя выбранного** — в серверных
настройках ST (одинаково для всех клиентов). Как только имя «повисает» (текста нет в
ЭТОМ браузере), два авто-фолбэка переписывают выбор и **персистят** его:

1. `settings-sync.js:390-396` — syncPromptEditor: имени нет среди опций → первый пункт
   ('main') + `saveSettings()`. Вызывается при каждой загрузке страницы через
   `renderPanel → syncPanelVisibility` (`index.js:267,371`), не только при открытии настроек.
2. `generator.js:57-63` — loadStylePrompt: fetch `chat-styles/<имя>.md` даёт 404 (юзер-имя
   всегда 404) → персист-фолбэк на 'main'. Срабатывает при первой генерации.

Когда имя повисает (по убыванию вероятности): другой браузер/устройство на том же
сервере; другой origin того же браузера (localhost ≠ 127.0.0.1 ≠ LAN-IP — IndexedDB
разный); «Clean extension data» в менеджере расширений ST или удаление расширения с
галочкой «Also clean up extension data» — хук `clean` (`index.js:124-130`) стирает
`LF_PROMPTS` (ВСЕ шаблоны + API-ключ + pinned + лог); у ST это только ручные кнопки
(extensions.js release: «Clean extension data» → callExtensionHook clean:1448, delete с
галочкой → 1565; F5/рестарт/enable/disable/update хранилище не трогают). Эвикция
хранилища браузера (приватный режим, Safari ITP — не проверялось) — тот же эффект.

Тестов на оба фолбэка нет (settings-sync.test.mjs покрывает stale-guard и savePromptAs).
Направление фикса и сверка с рекомендацией разработчиков ST — в §8.1.

### 8.1 Сверка с рекомендацией ST «Don't store large data in extensionSettings» (2026-09-09)

Официальные доки [Writing Extensions → Best Practices → Performance]
(https://docs.sillytavern.app/for-contributors/writing-extensions/; исходник:
SillyTavern/SillyTavern-Docs, `For_Contributors/Writing-Extensions.md`, раздел
Performance) действительно требуют: «Don't store large data in `extensionSettings`» —
settings загружаются в память и часто сохраняются. Но их же пример задаёт масштаб
«large»:

```js
// BAD - Don't store large data
extensionSettings[MODULE_NAME].largeDataset = { /* megabytes of data */ };
// GOOD - Use localforage
await localforage.setItem(`${MODULE_NAME}_data`, largeData);
```

Граница — **мегабайты** (блобы/булк-датасеты), не килобайты. Наши объёмы: builtin-вайб
`chat-styles/main.md` = 4.6 КБ, дефолтный `jailbreakText` = 864 символа (уже в
extensionSettings), пользовательский вайб — обычно единицы КБ. Практика самих
разработчиков ST: официальные расширения держат в `extension_settings` текстовые
коллекции — все regex-скрипты пользователя (`extensions/regex/index.js:1268`, release) и
конфиг Quick Reply (`extensions/quick-reply/index.js:107-109`). Целиком settings.json
и так POST-ится на каждое debounced-сохранение — добавка в единицы-десятки КБ не меняет
класса.

**Вывод: к нашему случаю (тексты вайбов) рекомендация НЕ применяется.** Она бьёт по
другому: фиды (уже серверные файлы), звуки (уже серверные файлы), API-ключ (localforage;
доки отдельно требуют не хранить секреты в extensionSettings — соблюдено). Проект в
целом следует этому разделу доков.

Оговорки при переносе шаблонов в extensionSettings: (а) размер не ограничен извне —
юзер может вставить огромный вайб, нужен мягкий лимит с предупреждением (~50–100 КБ на
шаблон / суммарно), чтобы остаться в «килобайтном» классе; (б) доки назначают
localforage «данным», extensionSettings — «настройкам»; тексты шаблонов — контент, но
малый; (в) семантика onClean: сейчас он стирает LF_PROMPTS — после переноса Clean-кнопка
перестанет удалять шаблоны; решить, честно ли это для «Clean extension data».

Варианты фикса (выбор за владельцем):
- **A. extensionSettings** — просто, синхронно, кроссбраузерно, переживает Clean +
  мягкий лимит размера + разовая миграция из localforage. Докам не противоречит при
  наших объёмах.
- **B. серверный файл** через существующие обёртки user-files (`dsc_templates.json`),
  localforage как кэш — консистентно с фидами/звуками и «доковским» разделением, но
  асинхронные пути в редакторе и своя политика Clean.
- **В любом варианте**: убрать персист из обоих фолбэков (`settings-sync.js:390-396`,
  `generator.js:57-63`) — выбор меняется только явным действием пользователя;
  отсутствие текста — видимая ошибка, транзиентный 'main' без записи.
