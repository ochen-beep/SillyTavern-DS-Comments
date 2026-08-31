# DS Comments — Code Review (v0.9.2, rev. 2)

**Дата:** 2026-08-31
**Метод:** вычитка всего исходного кода (~11 000 строк) со сверкой каждой точки интеграции с SillyTavern по официальной документации (docs.sillytavern.app → For Contributors → UI Extensions) и первоисточникам ST.
**Верификация (rev. 2):** каждое утверждение ревью перепроверено против локально скачанных исходников **SillyTavern 1.18.0 @release** (`package.json` обеих веток = 1.18.0): `script.js`, `scripts/extensions.js`, `scripts/popup.js`, `scripts/templates.js`, `scripts/st-context.js`, `scripts/slash-commands/SlashCommand{,Parser,Executor,Closure}.js`, `style.css`, `src/endpoints/extensions.js`, `src/endpoints/files.js`. Итог верификации: **один пункт ревью снят как неверный (CHAT_RENAMED), один снят как неверный (Popup.show), один усилeн (z-index), добавлен один пропущенный критичный баг (слэш-команды)** — см. §9.
**Тесты:** `npm test` — **518/518 pass, 0 fail** (node:test, ~0.8 s).

---

## 1. Вердикт

Расширение **зрелое, аккуратно спроектированное и в целом образцово следующее конвенциям SillyTavern**. Все проверенные точки интеграции с ST-документацией и STContext корректны, **кроме одной: слэш-команды `/dscomments` построены на несуществующем в ST 1.18.0 свойстве `subcommands` и не работают** (P0). Часть решений (хранение ключа в localforage, epoch-guard для генераций, serialized write-chains, отсутствие прямых импортов вглубь ST) — лучше, чем у большинства расширений. Также найдены: значимый риск совместимости при установке (хардкод имени папки), CSS-коллизия с видимым эффектом, агрессивный z-index-override. Остальное — средние и мелкие замечания.

| Категория | Оценка |
|---|---|
| Соответствие манифесту/хукам ST | ✅ Полное, сверено с документацией и исходником `extensions.js` |
| Использование `getContext()` | ✅ Все 25+ членов существуют в `st-context.js` |
| События `eventSource` | ✅ Все имена валидны; payload-ы проверены по исходникам (в т.ч. CHAT_RENAMED — объект) |
| Слэш-команды | ❌ **Не работают: `subcommands` не поддержан ST 1.18.0 — см. P0** |
| Безопасность (XSS/ключи) | ✅ Сильная; 2 мелких замечания |
| Производительность | ✅ Хорошая; системная борьба с джанком продумана |
| Устойчивость/очистка ресурсов | ✅ Исключительно тщательная |
| Совместимость при установке | ⚠️ Хардкод имени папки — см. P1-1 |
| Тесты | ✅ 518 pass; есть дыры в покрытии UI/импорта |

---

## 2. Сверка с документацией SillyTavern

### 2.1 Манифест — ✅ валиден

Документированные поля: `display_name`, `loading_order`, `requires`/`optional` (deprecated), `dependencies`, `js`, `css`, `author`, `version`, `homePage`, `auto_update`, `minimum_client_version`, `i18n`, `hooks`. Манифест расширения использует ровно этот набор.

- `hooks: { update, enable, disable, activate, clean }` — соответствуют документированному набору (`install/update/delete/enable/disable/activate/clean`); имена функций-экспортов в `index.js` корректны, `onClean` возвращает Promise (документация разрешает).
- Подтверждено по исходнику `public/scripts/extensions.js`: `callExtensionHook` действительно гонит хук против `HOOK_TIMEOUT = 5000` через `Promise.race` — комментарий автора в `index.js:115-121` о гонке хуков и `Promise.allSettled` в `onClean` **точно соответствует реализации ST**.
- `i18n: { ru, ru-ru }` — механизм документирован; ST игнорирует неизвестные локали молча, так что ключ `ru` безвреден, но, скорее всего, мёртвый (локали ST — вида `ru-ru`). Дублирование безвредно, можно оставить как defensive.
- `homePage: ""` — пустая строка; не ошибка, но лучше указать URL или убрать.
- `minimum_client_version: "1.18.0"` — документированное поле; все используемые API существуют и в более старых версиях, так что объявленный минимум скорее всего занижен, чем завышен — это безопасная сторона.

### 2.2 Хуки жизненного цикла — ✅

Тайминги из документации: `activate` — при успешной активации при загрузке страницы; `enable/disable` — до включения/выключения и сохранения настроек; `clean` — по кнопке «Clean extension data» и при удалении. Реализация (`index.js:71-129`) семантически соответствует: `onActivate` → единственный `init()` через контроллер отмены; `onDisable` → полная teardown-цепочка; `onClean` → teardown + удаление хранилищ с корректной защитой от «воскрешения» ключей отложенными записями (`clearEventLog` гасит debounce, `clearAllFeeds` ждёт write-chain) — это редкий по качеству класс ошибок, который здесь закрыт.

### 2.3 `getContext()` — ✅ все члены существуют

Проверено по `public/scripts/st-context.js` (release): `chat`, `chatId`, `characters`, `characterId`, `name1`, `name2`, `extensionSettings`, `saveSettingsDebounced`, `saveMetadata`, `chatMetadata`, `eventSource`, `eventTypes`, `translate`, `substituteParams`, `renderExtensionTemplateAsync`, `Popup`, `POPUP_RESULT`, `powerUserSettings`, `ConnectionManagerRequestService`, `SlashCommandParser`, `SlashCommand`, `registerDebugFunction`, `getRequestHeaders`, `maxContext`, `loadWorldInfo`, `getWorldInfoNames`, `getWorldInfoPrompt` — **все существуют**. Расширение вообще не импортирует `script.js`/`extensions.js` напрямую (кроме законсервированного `st-swipe-bridge.js`, который сейчас no-op) — это самый устойчивый к рефакторингам ST стиль, и он последовательно выдержан.

### 2.4 События — ✅

`CHAT_CHANGED`, `CHARACTER_MESSAGE_RENDERED`, `MESSAGE_SWIPED`, `MESSAGE_DELETED`, `MESSAGE_SWIPE_DELETED`, `MESSAGE_EDITED`, `CHAT_RENAMED`, `WORLD_INFO_ACTIVATED`, `APP_READY` — валидные `event_types`. Отсутствующие в старых версиях (`MESSAGE_SWIPE_DELETED`, `CONNECTION_PROFILE_UPDATED`, `WORLDINFO_UPDATED`, `APP_READY`) корректно защищены `if (ctx.eventTypes.X)` — событие просто не биндится. Это правильный защитный паттерн. Payload `CHAT_RENAMED` проверен по исходнику: ST эмитит **один объект** `{ avatarId, groupId, oldFileName, newFileName }` (`script.js:10656-10657`) — обработчик расширения `(detail) => noteChatRenamed(detail || {})` корректен (в ревью rev.1 это было сомнением — снято).

### 2.5 Хранение настроек — ✅ по конвенции

`extension_settings[MODULE_NAME]` + `saveSettingsDebounced()` + `lodash.merge(cloneDeep(defaults), stored)` + нормализация enum/чисел (`core.js:354-400`) — ровно рекомендуемый документацией паттерн. API-ключ custom-эндпоинта хранится в `SillyTavern.libs.localforage`, а не в settings.json — прямое следование best practice «никогда не хранить ключи в extensionSettings». Localforage — тоже не шифрованное хранилище (и это стоит проговорить в README), но угроза-модель та же, что у settings.json, так что решение корректно.

### 2.6 Шаблоны и i18n — ⚠️ один риск

`ctx.renderExtensionTemplateAsync('third-party/DS Comments', 'settings')` — API по документации; верифицировано по исходникам: сигнатура `(extensionName, templateId, templateData = {}, sanitize = true, localize = true)`, путь строится как `scripts/extensions/${extensionName}/${templateId}.html` (`extensions.js:137-139`), результат прогоняется через `DOMPurify.sanitize` (`templates.js:76-77`), `localize = true` применяет `data-i18n` (включая `[title]`/`[placeholder]`). **Но первый аргумент — литеральное имя папки расширения**; см. P1-1. Загрузка `manifest.i18n` тоже верифицирована: ключ сравнивается с текущей локалью строго (`extensions.js:855` `manifest.i18n[currentLocale]`), локали `ru` в ST не существует (`public/locales/ru.json` → 404, `ru-ru.json` → 200), поэтому ключ `ru` в манифесте мёртв, но безвреден.

### 2.7 Slash-команды и Debug-функции — ❌ команды сломаны, debug-функции ✅

`SlashCommandParser.addCommandObject(SlashCommand.fromProps({...}))` — документированный «new way», регистрация проходит. **Но использованное свойство `subcommands` не существует ни в API ST 1.18.0, ни в документации** (см. P0 ниже): документированный пример — плоская команда с `callback` + `namedArgumentList`/`unnamedArgumentList`. Как следствие, все три команды (`/dscomments toggle|regenerate|clear`) падают в рантайме. `registerDebugFunction(id, name, description, callback)` — документирован и используется корректно. «Одна регистрация на страницу» (`registration-lifecycle.js`) с переживанием enable/disable — правильное решение: в `SlashCommandParser` 1.18.0 нет операции разрегистрации (проверено grep-ом — `removeCommand`/`unregister` отсутствуют).

### 2.8 Серверное файловое API — ✅ сверено с серверным исходником

`user-files.js` использует `POST /api/files/upload {name, data: base64}`, `POST /api/files/delete {path}`, `POST /api/files/verify {urls}` и статический `GET /user/files/<name>`. По `src/endpoints/files.js` (release) подтверждено: все три маршрута существуют, upload — атомарная запись (`writeFileSyncAtomic(..., 'base64')`), delete отклоняет пути вне каталога пользователя, verify возвращает карту `{url: bool}`, имя файла валидируется `validateAssetFileName`. Расширение аккуратно генерирует имена (`dsc_<guid>.json`, `dsc_sound_custom_N.<ext>`) из id, а не из пользовательского ввода — ограничение сервера соблюдено.

---

## 3. Находки

### P0 — критично (найдено при верификации rev. 2)

**P0-1. Слэш-команды `/dscomments` не работают: ST 1.18.0 не поддерживает `subcommands` — `index.js:848-887`.**
`buildSlashCommand()` регистрирует родительскую команду без `callback`, с массивом `subcommands`:
```js
SlashCommand.fromProps({ name: 'dscomments', subcommands: [ SlashCommand.fromProps({ name: 'toggle', ... }), ... ] })
```
Верификация по исходникам ST 1.18.0 (@release, ровно целевая версия расширения):
- слова «subcommand» **нет ни в одном файле слэш-стека**: `SlashCommandParser.js`, `SlashCommand.js` (в т.ч. список полей класса: `callback`, `helpString`, `aliases`, `namedArgumentList`, `unnamedArgumentList` — без `subcommands`), `SlashCommandExecutor.js`, `SlashCommandClosure.js`, а также в `script.js` и `extensions.js`; нет его и в документации (`Writing-Extensions.md` — 0 упоминаний, пример — плоская команда с `callback`);
- `fromProps` — это просто `Object.assign(new this(), props)` (SlashCommand.js): `subcommands` молча оседает мёртвым свойством, `callback` остаётся `undefined`;
- `addCommandObject` не валидирует наличие `callback` (extensions.js:65-72 парсер) — регистрация «успешна»;
- исполнение — прямой вызов `executor.command.callback(args, value ?? '')` (`SlashCommandClosure.js:438`), без какого-либо диспетчера подкоманд.

Итог: **любой ввод `/dscomments`, `/dscomments toggle|regenerate|clear` бросает `TypeError: executor.command.callback is not a function`**, обёрнутый в `SlashCommandExecutionError`. Фича из README («Slash commands: /dscomments toggle|regenerate|clear») полностью нерабочая; тесты её не ловят, потому что мок `SlashCommand.fromProps` в тест-рантайме принимает любые пропсы.
**Фикс (два варианта):**
1. Одна плоская команда с диспетчем по первому неименовному аргументу:
```js
SlashCommand.fromProps({
    name: 'dscomments',
    helpString: '…',
    unnamedArgumentList: [SlashCommandArgument.fromProps({
        description: 'toggle | regenerate | clear',
        typeList: ARGUMENT_TYPE.STRING,
        isRequired: true,
        enumList: ['toggle', 'regenerate', 'clear'],
    })],
    callback: (_named, unnamed) => dispatch(String(unnamed ?? 'toggle')),
})
```
2. Три плоские команды `/dscomments-toggle|regenerate|clear`.
Плюс: временный smoke-тест против реального `fromProps`-контракта (callback обязателен).

### P1 — важные

**P1-1. Хардкод имени папки в `renderExtensionTemplateAsync` — `index.js:218` (верифицировано).**
```js
const settingsHtml = await ctx.renderExtensionTemplateAsync('third-party/DS Comments', 'settings');
```
`'third-party/DS Comments'` — путь к папке расширения. Работает только если папка называется буквально `DS Comments`. Верифицировано: путь строится как `scripts/extensions/${extensionName}/${templateId}.html` (`extensions.js:137-139`), а при установке из git URL папка называется `sanitize(path.basename(url, '.git'))` — по имени репозитория (`src/endpoints/extensions.js:122`), т.е. почти никогда `DS Comments`. README (`README.md:39`) предписывает установку «в новую папку» с произвольным именем. При любом другом имени папки шаблон отдаст 404, сработает `catch { warn(...) }` и **панель настроек молча никогда не появится**. Это главный риск совместимости.
**Фикс:** имя папки уже известно в рантайме — `core.js:9` строит `BASE_URL` из `import.meta.url`; возьмите последний сегмент пути и подставьте:
```js
const folderName = BASE_URL.split('/').pop();
const settingsHtml = await ctx.renderExtensionTemplateAsync(`third-party/${folderName}`, 'settings');
```
(Заодно это уберёт зависимость от переименований.) Тест-хелперы уже подменяют BASE_URL — покроется тестом.

**P1-2. CSS-коллизия класса `.dsc_header` — `style.css:84` vs `style.css:235`.**
Класс используется для двух разных элементов: заголовка плавающего окна (`window.js:266`) и «шапки» сообщения в ленте (`renderer.js:76`). Два правила с одинаковой специфичностью (0,1,0) → **позднее побеждает для обоих элементов**. Для окна это отменяет `height: 44px` (`height: auto`), `padding: 0 10px`, тёмную подложку `background`, `border-bottom`, `cursor: grab` (перебит на `default`), меняет `align-items: center → baseline` и `gap: 8px → 5px`. Обратно, в сообщения из первого правила протекают `touch-action: none` и `user-select: none`. *(Уточнение rev. 2: на экранах ≤768px мобильное правило `#dscWindow.dsc_mobile .dsc_header { touch-action: pan-y !important }` — селектор-потомок — случайно накрывает и шапки сообщений, так что вертикальный скролл с ника на телефоне всё же работает; утечка `touch-action: none` реальна на тач-экранах шире 768px. Визуальная поломка заголовка окна действует везде.)*
**Фикс:** скоупить правило сообщений: `.dsc_message .dsc_header { … }` (или переименовать в `.dsc_msg_header`). Заодно вернуть заголовку окна его вид; проверить, что `--dsc-header-h: 44px` (используется в позиционировании мобильных меню, `quickmenu.js:79`, `typography.js:63`) снова соответствует фактической высоте.

**P1-3. `onClean` не удаляет серверные файлы чужих чатов — `index.js:91-129` + `feed-file-store.js:519` (верифицировано).**
«Clean extension data» удаляет localforage-ключи, загруженные звуки и файл **текущего** чата (`clearFeedFile`). Файлы `dsc_<guid>.json` остальных чатов остаются в `data/<user>/user/files/` навсегда, как и `guid`-скаляры в chatMetadata. Для кнопки, обещающей очистку данных расширения, это неполно. Верифицировано: в `src/endpoints/files.js` ST 1.18.0 есть только маршруты `/sanitize-filename`, `/upload`, `/delete`, `/verify` — **list-эндпоинта нет**, «собрать все dsc_*.json» клиентом нельзя. Варианты: (а) явно задокументировать ограничение в README/USER_GUIDE; (б) при удалении чата в ST вычищать его файл (подписка на событие удаления чата); (в) завести реестр файлов в extensionSettings и удалять по нему.

**P1-4. ~~Payload `CHAT_RENAMED`~~ — СНЯТО при верификации.**
Проверено по исходнику ST 1.18.0: `script.js:10656` эмитит **один объект** `const eventData = { avatarId, groupId, oldFileName, newFileName }; await eventSource.emit(event_types.CHAT_RENAMED, eventData);` — обработчик расширения `(detail) => noteChatRenamed(detail || {})` корректен, страховка не нужна.

**P1-5. ~~`Popup.show.confirm/input`~~ — СНЯТО при верификации.**
Проверено по `popup.js` ST 1.18.0: `static show = showPopupHelper` (:853), где `input: (header, text, defaultValue = '', popupOptions = {})` (:96, резолвится строкой или null) и `confirm: (header, text)` → `POPUP_RESULT`. Использование в `core.js:685-718` (позиционные аргументы, сравнение с `POPUP_RESULT.AFFIRMATIVE`) точно соответствует сигнатурам. Микронюанс без последствий: ST возвращает `''` при «OK с пустым вводом», расширение трактует это как отмену (`showInputModal` требует непустое имя шаблона — это и есть желаемое поведение).

### P2 — средние

**P2-1. `setStatus()` вставляет непроверенную строку через `innerHTML` — `chrome.js:31`.**
Сейчас вызывается только с константной переведённой строкой, но контракт функции не защищает от будущего `setStatus(...)` с сообщением об ошибке сервера (как это уже делается в `setFeedText`, где текст экранируется). Экранируйте `message` (или явно докомментируйте инвариант «только доверенные строки»).

**P2-2. Глобальный z-index override в style.css расширения — `style.css:608` (усилено при верификации).**
```css
.popup, #dialogue_popup, #shadow_popup { z-index: 4000 !important; }
```
Верифицировано по `style.css` ST 1.18.0: нативные `#dialogue_popup` (:3677) и `#shadow_popup` (:3861) имеют **z-index: 9999**. Правило расширения не просто «влияет на чужой DOM» — оно **понижает** все нативные попапы с 9999 до 4000, где они сталкиваются с собственными слоями ST: `#cfgConfig` и `#movingDivs>div` (4000), `#character_popup` (4001), комбо-дровер (4005), `#shadow_select_chat_popup` (4100) — попапы ST могут оказаться **под** его же оверлеями. Комментарий расширения «below modals (4000)» и тест `window-stacking.test.mjs` фиксируют неверное предположение о слоях ST. Правило применяется всегда, даже когда окно DS Comments удалено из DOM. Правильный фикс: удалить правило — при 9999 нативные попапы и так выше окна (2999) и меню (3500) расширения; тест переписать на инвариант «окно ниже нативных попапов ST», а не на конкретное 4000.

**P2-3. Импорт комментариев без ограничений — `index.js:773-797`, `feed-file-store.js:553`.**
`JSON.parse(file.text())` без лимита размера; `mergeImportedEntries` принимает неограниченное количество записей с HTML любого размера (проверка `validPayload` — только `typeof html === 'string'`). XSS здесь нет (рендер идёт через `sanitize()` в `feed-controller.js:54-67` — корректно), но 100-МБ файл раздует зеркало и серверный файл. Рекомендация: лимит на размер файла (как для звуков — 5 МБ) и на количество/размер записей.

**P2-4. Двухвкладочный race guid оставляет осиротевший файл — `feed-file-store.js:304-320`.**
Если guid свежесоздан и fallback-файл `dsc_<hash>.json` существует (вторая вкладка успела), зеркало берётся из fallback-файла, но `_loadedKey = mainKey` — все последующие записи пойдут в файл guid, а fallback-файл останется навсегда с устаревшей копией. Комментарий «whichever file exists wins the merge» описывает первый шаг, но не хвост. Рекомендация: после успешной записи в guid-файл удалять fallback-файл (или merger-ить в него наоборот).

**P2-5. Дублирование resolveSTMacro для jailbreak — `generator.js:571-573` vs `generator.js:238-240`.**
`assembleCompletePrompt` уже подставил макросы в `parts.jailbreak`, а `jailbreakBlock` в `generateFeed` вычисляется повторно и используется только в trace (`jailbreak: !!jailbreakBlock`). Возьмите `Boolean(assembled.…)`, добавив флаг в результат `assembleCompletePrompt` — минус лишний проход макросов и мёртвая переменная.

**P2-6. Двойной `observeRestore(restore)` — `index.js:346-357`.**
Один и тот же promise оборачивается дважды (лог + возврат) — безвредно, но это два независимых catch-цепочка; достаточно `.finally`-лога внутри одной обёртки.

**P2-7. `aria-live="polite"` на всём фиде — `window.js:275`, `feed-controller.js`.**
Полная перезапись `innerHTML` фида при каждой генерации/восстановлении заставит скринридеры зачитывать всю ленту. Для чат-подобной ленты лучше `role="log"` без `aria-live` (или `aria-relevant="additions"`).

**P2-8. i18n: неполный/мёртвый перевод — `src/i18n/ru-ru.json`** *(мёртвость ключей подтверждена точным grep-ом по коду и шаблонам — 0 использований)*.
- `"dscomments.connection.noApiKey": "Custom API key is not set"` — не переведена (строка 12).
- Мёртвые ключи: `dscomments.command.cacheClear`, `dscomments.command.help`, `dscomments.profile.loading`, `dscomments.profile.none`, `dscomments.lore.error`, `dscomments.lore.none`, `dscomments.empty.disabled`, `dscomments.empty.noFeed` — в коде не используются (в `test/i18n.test.mjs` стоит добавить встречную проверку «ключи без ссылок»).
- Ключ локали `ru` в манифесте мёртв, но безвреден: верифицировано, что ST сравнивает ключ со строкой текущей локали строго (`extensions.js:855`), а локали `ru` в ST не существует (`public/locales/ru.json` → 404, `ru-ru.json` → 200).
- Фолбэки в `tr()` — английские, ключи — `dscomments.*`: структура «английская база + русская локаль» соответствует конвенции ST, это ок; просто доведите покрытие до 100%.

### P3 — мелочи и стиль

- **Сломанные JSDoc-строки** (потерялись `@param`/`{type}`): `core.js:167-168` (`isEpochCurrent`), `pinned-store.js:51-52` (`loadPinnedFeeds`), `parser.js:131-133` и `161-162`, `generator.js:~401-403` (`generateFeed`), `event-log.js:61` (`recordEvent`), `dom-ready.js:24-25`. *(Поправка rev. 2: в первой редакции эти цитаты частично указывали не на те файлы — `core.js:51` и `lifecycle.js:51` — теперь перепроверено построчно.)* При включённом `// @ts-check` такие строки не проверяются — сейчас это просто шум.
- **Сбитые отступы**: `settings-sync.js:232-248` (комментарий и код на нулевой колонке внутри функции), `events.js:535-538` (catch с чужим отступом), `feed-gestures.js:188-191`.
- **`dsc_reaction` с `cursor: pointer`** (`style.css:293`) — чипы выглядят кликабельными, обработчика нет. Либо `cursor: default`, либо обработка клика (например, всплывающий счётчик).
- **Шеврон секций не вращается** при `aria-expanded="true"` (settings.html + style.css есть только фон) — мелкий визуальный штрих.
- **Версия продублирована руками** в футере настроек (`settings.html:211`, `v0.9.2`) — рассинхронизируется при релизе. Можно проставлять из `getCtx().getExtensionManifest?.(...)` или скриптом сборки.
- **`homePage: ""`** в манифесте — заполните или уберите.
- **`populateSoundDropdown` без await** в `init()` (`index.js:259`) — функция синхронная, сигнатура `async` лишняя.
- **`deleteUserFile` 404 → не ошибка** (`user-files.js:43-50`) — корректно; но `delete failed: <status>` без тела ответа затруднит диагностику нестандартных ошибок сервера.

---

## 4. Безопасность — сильная сторона

- **Весь HTML модели и импортов проходит DOMPurify** (`core.js:268-295`) с `FORBID_TAGS: img/a/video/audio/source/iframe/object/embed` — закрывает и классический XSS, и prompt-injection трекинг-пиксели/фишинг-ссылки. Фолбэк при сбое санитайзера — `escapeHtml` (fail closed). Рендерер строит доверенную разметку, пользовательские части — через `escapeHtml`; mini-markdown в `renderer.js` выполняется **после** санитизации и не создаёт атрибутов. Феед-контроллер (`feed-controller.js:54-67`) санитизирует и кэш (в т.ч. импортированный) перед `innerHTML` — forged `META_KEY` в чужом чате не исполнится.
- **Ключ API** — localforage, никогда не в settings.json; уходит только на авторизованный origin. HTTP-эндпоинты: credentials в URL запрещены, схема ограничена http/https, loopback-HTTP с предупреждением, прочий HTTP — явный одноразовый confirm с персистентным allowlist и rollback при неудачной записи (`connection.js:255-285`). Таймаут 120 с, отмена — через склеенный AbortController. Образцово.
- Замечания: см. P2-1 (`setStatus`) и P2-3 (лимиты импорта). Также стоит честно отметить в документации, что localforage — не защищённое хранилище (это ограничение платформы, не ошибка).

## 5. Производительность — хорошая

- **Fingerprint-кэш** генерации (`generator.js:322-356`) убирает повторные localforage/profilе-чтения с горячего пути `CHARACTER_MESSAGE_RENDERED`; ключ `(epoch, chatId, settingsKey)` продуман, а инвалидации (CHAT_CHANGED, lore picker, CONNECTION_PROFILE_UPDATED) покрыты.
- IntersectionObserver + rAF-коалесинг, троттлинг catch-up скана (200 мс), `contain: layout paint style` на сообщениях, rAF-коалесинг drag/resize/индикатора жестов, debounce theme-sync — систематическая борьба с джанком, с честными комментариями о том, почему именно так.
- `getContext()` создаёт новый объект на вызов — код это знает и фиксирует один экземпляр на горячих путях (`events.js:306`).
- Существенных проблем не найдено; catch-up скан на очень длинных чатах — осознанный компромисс с троттлингом.

## 6. Архитектура и качество кода

Сильные стороны: чёткие границы модулей и «единый владелец» для DOM фида (`feed-controller.js`); mode-agnostic адаптер кэша (`cache.js`); epoch-guard против меж-чатовых гонок генерации (без AbortSignal у generateRaw — правильный вывод); serialized write-chains с защитой от воскрешения данных (pinned-store, feed-file-store, event-log); DI-реестры для разрыва циклов импорта; test-only экспорты за `NODE_TEST` guard; комментарии объясняют *почему* (контракты, гонки, мобильные каверзы), а не *что*.

Стоимости этого качества: `state` — глобальный синглтон; два скрытых DI-реестра (lifecycle `_deps`, core providers) усложняют трассировку; логика restore продублирована между `cache.js`/`events.js`/`index.js` (осознанно, но это самая сложная для чтения часть). Это приемлемые компромиссы для размера проекта.

## 7. Тесты — 518/518

`node --test` + `stub-runtime.mjs` без jsdom; NODE_TEST-гарды изолируют тестовую поверхность. Покрытие охватывает: парсер (включая repair/truncated), эпохи/гонки генерации, pinned/file store, lifecycle (вкл. teardown во время drag/resize), жесты, geometry, sanitize, i18n, sounds-on-disk, manifest.

Рекомендации по покрытию: (1) тест на импорт экспорт-файла с каверзным HTML (проверка, что `sanitize` на границе импорта), (2) тест соответствия `FIELD_MAP` ↔ id в settings.html (аналог sounds-on-disk), (3) тест «каждый ключ i18n используется в коде/шаблоне» (обратная сторона i18n.test), (4) дым-тест, что `renderExtensionTemplateAsync` вызывается с существующим путём (после фикса P1-1 — от BASE_URL).

## 8. Приоритизированный план действий

1. **P0-1** — починить слэш-команды (плоская команда с диспетчером или три отдельные) + тест, что у зарегистрированной команды есть `callback`.
2. **P1-1** — динамическое имя папки для `renderExtensionTemplateAsync` (+тест).
3. **P1-2** — развести `.dsc_header` окна и сообщения; вернуть окну задуманный вид.
4. **P2-2** — убрать глобальный z-index override (нативные попапы ST и так выше: 9999 > 3500) и переписать `window-stacking.test.mjs` под реальную модель слоёв ST.
5. **P2-1, P2-3** — экранирование в `setStatus`, лимиты импорта.
6. **P1-3** — задокументировать/ограничить объём «Clean».
7. P2-4…P2-8, P3 — по мере релиза 0.9.3.

*(P1-4 «CHAT_RENAMED» и P1-5 «Popup.show» из первой редакции сняты при верификации — см. §9.)*

---

## 9. Протокол верификации (rev. 2)

Каждое утверждение ревью сверено с локально скачанными исходниками **SillyTavern 1.18.0 @release** (версия подтверждена по `package.json`: release и staging = 1.18.0 — ровно `minimum_client_version` расширения) и официальной документацией (`SillyTavern-Docs@main/For_Contributors/Writing-Extensions.md`).

| Утверждение ревью | Результат | Свидетельство |
|---|---|---|
| `HOOK_TIMEOUT = 5000`, гонка хуков | ✅ верно | `extensions.js` (`callExtensionHook`: `const HOOK_TIMEOUT = 5000`, `Promise.race`) |
| Хуки манифеста (`activate/enable/disable/clean/update`) документированы | ✅ верно | документация: таблица hooks + пример манифеста с `clean` |
| Все члены `getContext()` существуют | ✅ верно | `st-context.js` (полный список, включая `Popup`, `POPUP_RESULT`, `ConnectionManagerRequestService`, `translate`, `registerDebugFunction`) |
| **NEW. `subcommands` поддержан** | ❌ **опровержено → P0-1** | 0 вхождений «subcommand» в `SlashCommandParser.js`, `SlashCommand.js`, `SlashCommandExecutor.js`, `SlashCommandClosure.js`, `script.js`, `extensions.js` и в документации; исполнение — `SlashCommandClosure.js:438` `executor.command.callback(args, value)`; `fromProps` = `Object.assign` (валидации нет) |
| P1-1: путь шаблона = имя папки; при git-установке папка = имя репо | ✅ подтверждено | `extensions.js:137-139` (`scripts/extensions/${extensionName}/${templateId}.html`); серверный `src/endpoints/extensions.js:122` (`sanitize(path.basename(parsedUrl.pathname, '.git'))`) |
| P1-3: list-эндпоинта для user-files нет | ✅ подтверждено | `src/endpoints/files.js`: маршруты только `/sanitize-filename`, `/upload`, `/delete`, `/verify` |
| P1-4: payload `CHAT_RENAMED` сомнителен | ⛔ снято — обработчик корректен | `script.js:10656-10657`: `const eventData = { avatarId, groupId, oldFileName, newFileName }; emit(CHAT_RENAMED, eventData)` |
| P1-5: `Popup.show.confirm/input` сомнительны | ⛔ снято — существуют и используются верно | `popup.js:853` (`static show = showPopupHelper`), `:96` (`input(header, text, defaultValue)`), `confirm(header, text)` → `POPUP_RESULT` |
| P2-2: override чужого z-index | ✅ усилено | `style.css` ST: `#dialogue_popup` :3677 и `#shadow_popup` :3861 = **9999**; override понижает до 4000 — ниже `#character_popup` (4001), дровер-комбо (4005), `#shadow_select_chat_popup` (4100) |
| P2-8: 8 мёртвых i18n-ключей | ✅ подтверждено | точный grep по `index.js`, `src/`, `settings.html` — 0 использований (совпадения были только по подстроке `disabledTitle`/`disabledHint` и т.п.) |
| Локаль `ru` в манифесте мертва/безвредна | ✅ подтверждено | `extensions.js:855` — строгое сравнение `manifest.i18n[currentLocale]`; `public/locales/ru.json` → 404, `ru-ru.json` → 200 |
| `renderExtensionTemplateAsync` саницирует HTML и применяет `data-i18n` | ✅ подтверждено | сигнатура `(…, sanitize = true, localize = true)` (`extensions.js:137`); `DOMPurify.sanitize(result)` (`templates.js:76-77`) |
| Разрегистрировать слэш-команду нельзя → перманентная регистрация оправдана | ✅ подтверждено | в `SlashCommandParser.js` нет `removeCommand`/`unregister` |
| Цитаты строк (P3: сломанные JSDoc, отступы, версия в футере, `homePage` и т.д.) | ✅/поправлено | все перепроверены построчно; исправлены 2 неверные цитаты (`core.js:51` → `pinned-store.js:51-52`; `lifecycle.js:51` — убрана, там дефекта нет) |
