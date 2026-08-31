# DS Comments — план исправлений по итогам code review (v0.9.2 → v0.9.3)

Основан на `CODE_REVIEW.md` (rev. 2, верифицирован по исходникам SillyTavern 1.18.0).
Порядок выполнения — §11. После каждого шага: `npm test` (сейчас 518/518).

**Перед началом:** папка проекта — не git-репозиторий. Выполнить `git init && git add -A && git commit -m "baseline 0.9.2"` для безопасного отката.

---

## Fix 1 (P0-1) — Слэш-команды: заменить несуществующие `subcommands` на плоскую команду

**Проблема.** `index.js:848-887`: `SlashCommand.fromProps({name:'dscomments', subcommands:[…]})` — свойства `subcommands` нет в ST 1.18.0; родительская команда регистрируется без `callback`, и каждый ввод `/dscommands …` падает с `TypeError` (`SlashCommandClosure.js:438` вызывает `executor.command.callback` напрямую).

**Целевой синтаксис для пользователя не меняется:** `/dscomments toggle` и т.д. — `toggle` становится первым неименованным аргументом.

### Шаги

1. **Вынести билдер в отдельный модуль** `src/slash-commands.js` (сейчас `buildSlashCommand` живёт в `index.js` и не тестируется — тесты `registration-lifecycle` подставляют свою заглушку):
   ```js
   // src/slash-commands.js
   import { state, tr } from './core.js';

   /**
    * Плоская команда /dscomments <action>. ST 1.18.0 не поддерживает subcommands —
    * диспетчеризация по первому неименовальному аргументу.
    * @param {{ SlashCommand: object, SlashCommandArgument?: object, ARGUMENT_TYPE?: object }} st
    * @param {{ toggle: Function, regenerate: Function, clear: Function }} handlers
    */
   export function buildDscommentsCommand(st, handlers) {
       const { SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = st;
       const actions = {
           toggle: handlers.toggle,
           regenerate: handlers.regenerate,
           clear: handlers.clear,
       };
       const props = {
           name: 'dscomments',
           helpString: tr('/dscomments [toggle|regenerate|clear] — control DS Comments', 'dscomments.command.helpMain'),
           returns: 'a status message',
           callback: (_named, unnamed) => {
               const action = String(unnamed ?? '').trim().toLowerCase() || 'toggle';
               const fn = actions[action];
               if (!fn) {
                   return tr('Unknown action "{a}". Use toggle, regenerate or clear.', 'dscomments.command.unknownAction')
                       .split('{a}').join(action);
               }
               return fn();
           },
       };
       if (SlashCommandArgument && ARGUMENT_TYPE) {
           props.unnamedArgumentList = [SlashCommandArgument.fromProps({
               description: 'toggle | regenerate | clear',
               typeList: ARGUMENT_TYPE.STRING,
               defaultValue: 'toggle',
               enumList: ['toggle', 'regenerate', 'clear'],
           })];
       }
       return SlashCommand.fromProps(props);
   }
   ```
2. **Перенести тела трёх колбэков** из текущих `subcommands` (`index.js:851-885`) в `handlers` в `index.js` — логика без изменений (toggle → `state.settings.enabled = !…; saveSettings(); syncPanelToSettings(); return …`; regenerate → проверки + `generateFeed(null,null,true)`; clear → `abortActiveGeneration(); clearFeed(); setFeedText(''); updatePostIndicator();`).
3. **`src/registration-lifecycle.js`**: в `ensureSlashCommandRegistered` брать из контекста также `SlashCommandArgument` и `ARGUMENT_TYPE` (оба есть в `getContext()` ST — проверено по `st-context.js`) и передавать в `buildSlashCommand(st)` одним объектом; контроллер больше не передаёт `SlashCommand` позиционно.
4. **i18n:** добавить ключи `dscomments.command.helpMain`, `dscomments.command.unknownAction` (ru + fallback).

### Тесты (новый файл `test/slash-commands.test.mjs`)
- Заглушка `SlashCommand.fromProps = (p) => ({ …p })` (passthrough) — **главный регрессионный ассерт: `typeof cmd.callback === 'function'`** (именно это пропустил текущий сюит).
- Диспетчеризация: `callback({}, 'toggle')` вызывает `handlers.toggle`; `''`/`undefined` → toggle; `'TOGGLE '` → toggle (lowercase+trim); `'bogus'` → строка про неизвестное действие и ни один handler не вызван.
- При наличии `SlashCommandArgument` в `st` — `unnamedArgumentList[0].enumList` равен `['toggle','regenerate','clear']`; при отсутствии — поля нет (деградация на старых ST).
- Обновить `test/registration-lifecycle.test.mjs` под новую сигнатуру `buildSlashCommand(st)` (заглушка в `makeSlashContext`).

### Ручная проверка
В реальном ST 1.18: `/dscomments toggle` дважды (вкл/выкл + тосты), `/dscomments regenerate`, `/dscomments clear`, `/dscomments` без аргумента, `/dscomments bogus`; автокомплит показывает enum.

**Усилие:** ~1–1.5 ч. **Риск:** низкий — пользовательский синтаксис сохранён.

---

## Fix 2 (P1-1) — Динамическое имя папки для шаблона настроек

**Проблема.** `index.js:218`: литерал `'third-party/DS Comments'`. При установке из git папка = `sanitize(basename(URL))` → шаблон 404 → панель настроек молча не появляется.

### Шаги
1. `src/core.js` после `BASE_URL` (строка 9):
   ```js
   // Folder name of the extension as ST addresses it (scripts/extensions/third-party/<name>).
   // Derived from BASE_URL so installs under any folder name work (git install
   // names the folder after the repository).
   export const FOLDER_NAME = BASE_URL.split('/').filter(Boolean).pop() || 'DS Comments';
   ```
2. `index.js:218`: `ctx.renderExtensionTemplateAsync(\`third-party/${FOLDER_NAME}\`, 'settings')` (+ импорт `FOLDER_NAME`).

### Тесты (`test/manifest.test.mjs` или рядом с существующими core-тестами)
- `FOLDER_NAME` непуст, не содержит `/`, `\`, пробелов по краям.
- В Node-рантайме `import.meta.url` — `file:///…/DS Comments/src/core.js` → `FOLDER_NAME === 'DS Comments'` (имя папки проекта) — ассерт «не захардкожен литералом»: изменить-имя-папки-тест не нужен, достаточно проверки деривации.

### Ручная проверка
Скопировать расширение в `data/<user>/extensions/ds-comments-test/` (другое имя) → панель настроек рендерится.

**Усилие:** ~15 мин.

---

## Fix 3 (P1-2) — Развести CSS-коллизию `.dsc_header` (окно vs сообщение)

**Проблема.** `style.css:84` (заголовок окна) и `style.css:235` (шапка сообщения) — один класс, одинаковая специфичность → позднее правило ломает заголовок окна (`height:auto`, `padding:0`, `background:none`, `border:none`, `cursor:default`), а первое протекает в сообщения (`touch-action:none`, `user-select:none`).

### Шаги (минимальный дифф, без переименования классов в JS)
1. `style.css:84` — селектор `.dsc_header {` → `#dscHeader {` (id уже есть: `window.js:266`). Специфичность 1-0-0 перекрывает класс-правило для всех общих свойств.
2. `style.css:98` — `.dsc_header:active { cursor: grabbing }` → `#dscHeader:active { … }`.
3. `style.css:235` — оставить для сообщений, но скоупить для явности: `.dsc_message .dsc_header { … }`.
4. `style.css:593` (мобильное) — `#dscWindow.dsc_mobile .dsc_header` → `#dscWindow.dsc_mobile > .dsc_header` (только прямой ребёнок-заголовок окна; сейчас селектор-потомок случайно накрывает шапки сообщений).
5. Проверить грепом, что других `.dsc_header`-селекторов нет: `grep -n "dsc_header" style.css`.

### Тесты (`test/window-stacking.test.mjs` — уже читает style.css; добавить кейс)
- Каждое вхождение селектора `.dsc_header` в style.css квалифицировано: начинается с `#dscHeader`, `.dsc_message` или `#dscWindow…>` — нет «голых» `.dsc_header {` правил (регресс контракта).
- Правило `#dscHeader` содержит `height: var(--dsc-header-h)`.

### Ручная проверка
Заголовок окна: высота 44px, тёмная полоса, нижняя граница, `cursor: grab`, drag работает. Сообщения: ник выравнен по базовой, длинный ник не прерывает touch-скролл ленты на тач-экране >768px. Мобильная версия: панель на весь экран, шапка не draggable.

**Усилие:** ~30 мин + QA. **Риск:** визуальный — прогнать обе темы.

---

## Fix 4 (P2-2) — Убрать глобальный z-index override

**Проблема.** `style.css:608`: `.popup, #dialogue_popup, #shadow_popup { z-index: 4000 !important; }` понижает нативные попапы ST (у них **9999**: `style.css:3677, 3861`) до 4000 — ниже `#character_popup` (4001), дровер-комбо (4005), `#shadow_select_chat_popup` (4100).

### Шаги
1. Удалить строку 608 целиком.
2. Обновить комментарий у `#dscWindow` z-index 2999 и у `.dsc_qs_menu`/`.dsc_popover` 3500: «нативные попапы ST — 9999, всегда выше».
3. `test/window-stacking.test.mjs`: заменить ассерт `assert.match(css, /\.popup,…4000 !important…/)` на `assert.doesNotMatch(css, /z-index:\s*4000\s*!important/)` («extension must not override host popup stacking»); ассерты 2999/3500 оставить.

### Ручная проверка
Открыть попап ST (например, подтверждение удаления чата) поверх открытого окна комментариев и открытого QS-меню — попап поверх всего.

**Усилие:** ~15 мин.

---

## Fix 5 (P2-1) — Экранировать сообщение в `setStatus`

**Проблема.** `src/ui/chrome.js:31` вставляет `message` в `innerHTML` без экранирования (сейчас вызовы только с константами, но контракт опасен).

### Шаги
1. Импортировать `escapeHtml` из `../core.js`; в `setStatus`:
   ```js
   overlay.innerHTML = `<span class="dsc_status_msg">${escapeHtml(message)}</span>${actionHtml}`;
   ```
   `actionLabel` тоже обернуть (константа, но инвариант должен держаться механически).

### Тесты (`test/chrome-regen.test.mjs` — там уже стабится `document.getElementById`)
- Стаб `#dscStatusOverlay` с capture-свойством `innerHTML`; `setStatus('<img src=x onerror=alert(1)>')` → в innerHTML есть `&lt;img` и нет `<img`.

**Усилие:** ~10 мин.

---

## Fix 6 (P2-3) — Лимиты на импорт комментариев

**Проблема.** `index.js:773-797` читает файл любого размера; `feed-file-store.js:553 mergeImportedEntries` принимает неограниченное число записей с HTML любого размера (XSS нет — рендер через `sanitize()`, риск — раздувание памяти/серверного файла).

### Шаги
1. `index.js handleImportFeeds`, до `file.text()`:
   ```js
   const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
   if (file.size > IMPORT_MAX_BYTES) {
       toastr?.error(tr('File is too large. Maximum: 5 MB.', 'dscomments.file.tooLarge'));  // ключ уже есть (звуки)
       return;
   }
   ```
2. `feed-file-store.js`, константы модуля + экспорт для тестов:
   ```js
   export const IMPORT_LIMITS = Object.freeze({ maxEntries: 2000, maxEntryHtmlChars: 200_000 });
   ```
   В `mergeImportedEntries`: пропускать записи с `html.length > maxEntryHtmlChars`; суммарно принять не более `maxEntries` (остальное пропустить с подсчётом).
3. Сигнатуру вернуть как `{ merged, skipped }` (число сейчас); обновить единственного клиента `index.js:784-791` (тосты: «Imported entries: {n}», при `skipped > 0` — доп. warning-тост «Пропущено записей: {n} (превышен лимит размера/количества)» — новый i18n-ключ `dscomments.storage.importSkipped`).

### Тесты (`test/feed-file-store.test.mjs`)
- Экспорт-документ с 3 записями, одна длиннее лимита → `merged: 2, skipped: 1`, длинной нет в зеркале.
- Документ с >maxEntries записями → merged == maxEntries.
- Клиентский тест лимита файла: не обязателен (тривиальная ветка), опционально в `sanitize.test`-стиле.

**Усилие:** ~40 мин.

---

## Fix 7 (P1-3) — Задокументировать границы «Clean extension data»

**Проблема.** `onClean` удаляет хранилища localforage, звуки и файл **текущего** чата; `dsc_<guid>.json` других чатов остаются навсегда (list-эндпоинта у files-API нет — проверено). Кнопка обещает больше, чем делает.

### Шаги (только документация в этом релизе)
1. `README.md`, раздел «Storage modes», абзац:
   > «Clean extension data» (и удаление расширения) очищает локальные хранилища браузера, загруженные звуки и файл комментариев **текущего** чата. Файлы `dsc_<guid>.json` остальных чатов остаются в пользовательских файлах — SillyTavern не даёт расширению перечислить их; при необходимости удаляйте вручную (Data Bank → user files, имя файла видно в экспорте комментариев чата).
2. `USER_GUIDE.md`, раздел «Ограничения», тот же текст по-русски.
3. Опционально (следующий релиз, не сейчас): реестр созданных guid-файлов в `extensionSettings[MODULE_NAME]` и удаление по нему в `onClean`.

**Усилие:** ~15 мин.

---

## Fix 8 (P2-4) — Двухвкладочная гонка guid: копировать и удалять fallback-файл

**Проблема.** `feed-file-store.js:304-320`: при свежесмиссеном guid и существующем fallback-файле `dsc_<hash>.json` его содержимое попадает только в зеркало; в guid-файл оно не копируется до ближайшей записи, а сам fallback не удаляется никогда (осиротевшая копия + риск «пустого» кэша на следующей сессии, если записей не было).

### Шаги
1. В ветке загрузки с `minted`:
   ```js
   let fallbackDoc = null;
   doc = await readFile(ctx, mainKey);
   if (!doc && minted) {
       fallbackDoc = await readFile(ctx, hashKeyOf(ctx));
       doc = fallbackDoc;
   }
   ```
2. После установки зеркала (`_mirror`, `_loadedKey = mainKey`), если `minted && fallbackDoc`:
   ```js
   // Копируем содержимое fallback в guid-файл, затем удаляем fallback —
   // обе операции через _writeChain, чтобы удаление не обогнало запись.
   const deadKey = hashKeyOf(ctx);
   const copied = schedulePersist({ ctx, key: mainKey, mirror: _mirror });
   _writeChain = copied.then(async ok => {
       if (!ok) return;                      // запись не прошла — fallback оставляем
       try { await deleteUserFile(deadKey); }
       catch (cause) { warn('fallback feed file cleanup failed (kept):', cause); }
   }).catch(() => {});
   ```
   (не через `schedulePersist`-возврат в `_writeChain` автоматом — schedulePersist сам ставит `_writeChain`; присвоение сверху удлиняет цепочку удалением.)
3. `recordEvent('log', 'event=feed_fallback_migrated …')` для диагностики.

### Тесты (`test/feed-file-store.test.mjs`; в `stub-runtime.mjs` уже есть in-memory FS `globalThis._stFiles` + `_stFilesReset()`)
- Сценарий: fresh chatMetadata (guid сминтится), в `_stFiles` лежит `dsc_<hash>.json` с 2 записями → после `loadFeedStore()` + `await _flushWriteChain()`: файл `dsc_<guid>.json` существует с теми же записями, fallback-файла больше нет.
- Отказ записи (стаб fetch `/api/files/upload` → 500): fallback остаётся на месте.

**Усилие:** ~45 мин. **Риск:** средний — трогает persistence-цепочку; прогнать весь `feed-file-store`-сюит.

---

## Fix 9 (P2-8) — i18n-гигиена

### Шаги
1. Перевести `src/i18n/ru-ru.json:12`:
   `"dscomments.connection.noApiKey": "Не задан API-ключ кастомного эндпоинта."`
2. Удалить 8 мёртвых ключей (проверено точным grep — 0 использований):
   `dscomments.command.cacheClear`, `dscomments.command.help`, `dscomments.profile.loading`, `dscomments.profile.none`, `dscomments.lore.error`, `dscomments.lore.none`, `dscomments.empty.disabled`, `dscomments.empty.noFeed`.
3. `manifest.json`: из `i18n` убрать ключ `"ru"` (локали `ru` в ST не существует — `extensions.js:855` строгое сравнение; остаётся `"ru-ru"`). Обновить `test/manifest.test.mjs:29-32` (deepEqual только `{'ru-ru': …}`).
4. Добавить новые ключи из Fix 1 и Fix 6 (`command.helpMain`, `command.unknownAction`, `storage.importSkipped`).

### Тесты (`test/i18n.test.mjs` — там уже есть разбор `data-i18n` с директивами `a;[attr]b`)
Новый тест «every locale key is referenced»: собрать множество использованных ключей —
- из кода: `readdirSync(src, {recursive:true})` + `index.js`, regex `/dscomments\.[A-Za-z0-9_.]+/g`;
- из `settings.html`: существующее расширение директив `data-i18n`;
assert: каждый ключ `ru-ru.json` ∈ множество. Это навсегда закрывает класс «мёртвых ключей».

**Усилие:** ~30 мин.

---

## Fix 10 (P3) — микро-партия косметики и мелких дефектов

| # | Что | Где | Действие |
|---|---|---|---|
| a | Сломанные JSDoc (потерян `@param`) | `core.js:167-168`, `pinned-store.js:51-52`, `parser.js:131-133`, `parser.js:161-163`, `generator.js:~401-403`, `event-log.js:61`, `dom-ready.js:24-25` | восстановить строки `* @param {…} name — …` |
| b | Сбитые отступы (только форматирование) | `settings-sync.js:232-248`, `events.js:535-538`, `feed-gestures.js:188-191` | вернуть в блок; проверить, что diff пуст по смыслу |
| c | `cursor: pointer` на некликабельных реакциях | `style.css:293` | `cursor: default` |
| d | Шеврон секции не вращается | `style.css` (блок `.dsc_section_header`) | добавить `transform: rotate(180deg)` при `[aria-expanded="true"]` + `transition: transform .15s` |
| e | Версия руками в футере настроек | `settings.html:211` | оставить текст, добавить тест: версия в settings.html === `manifest.json.version` (ловит рассинхрон на CI) |
| f | `homePage: ""` | `manifest.json:9` | заполнить при публикации репозитория (решение владельца) |
| g | Лишний `async` | `index.js:813 populateSoundDropdown` | убрать `async` (нет await) |
| h | Ошибка delete без тела ответа | `user-files.js:49` | `throw new Error(\`delete failed: ${res.status} ${await res.text().catch(() => '')}\`)` (как в upload) |
| i | Дубль `resolveSTMacro` для jailbreak | `generator.js:238-240` vs `571-573` | в `assembleCompletePrompt` добавить `jailbreakIncluded: Boolean(parts.jailbreak)` в результат; в `generateFeed` удалить повторный `resolveSTMacro`-блок, в trace использовать флаг |
| j | Двойная обёртка `observeRestore` | `index.js:345-357` | `const wrapped = observeRestore(restore); wrapped.then(trim…); return wrapped;` — одна цепочка вместо двух |
| k | `aria-live="polite"` на всём фиде | `window.js:275` | поставить `aria-live="off"` (полная замена innerHTML сейчас зачитывается скринридером целиком); сигналом остаётся `#dscIndicator` (aria-live=polite) |

**Усилие:** ~45–60 мин на всё. Тесты: (e) — новый мини-тест в `test/manifest.test.mjs`; остальное — без тестов (форматирование/стили), прогон полного сюита.

---

## 11. Порядок выполнения и усилия

| № | Фикс | Приоритет | Усилие | Зависимости |
|---|---|---|---|---|
| 1 | Fix 1 — слэш-команды | **P0** | 1–1.5 ч | — |
| 2 | Fix 2 — имя папки | **P1** | 15 мин | — |
| 3 | Fix 3 — `.dsc_header` | **P1** | 30 мин + QA | — |
| 4 | Fix 4 — z-index | **P1/P2** | 15 мин | — |
| 5 | Fix 5 — setStatus escape | P2 | 10 мин | — |
| 6 | Fix 6 — лимиты импорта | P2 | 40 мин | — |
| 7 | Fix 9 — i18n | P2 | 30 мин | после Fix 1 и 6 (их новые ключи) |
| 8 | Fix 8 — fallback-файл | P2 | 45 мин | — |
| 9 | Fix 7 — документация Clean | P2 | 15 мин | — |
| 10 | Fix 10 — микро-партия | P3 | 45–60 мин | — |

Итого ≈ 5 часов. Порядок выбран так, чтобы сначала ушли сломанные фичи (1–2), потом видимые регрессии (3–4), затем быстрые безопасности (5), и только потом трогающие persistence (8).

## 12. Финальный чек-лист релиза 0.9.3

1. `npm test` — все зелёные (518 старых + ~15–20 новых).
2. Ручной прогон на ST 1.18.0: слэш-команды (5 вариантов ввода), панель настроек при нестандартном имени папки, вид заголовка окна + drag, попапы поверх окна/меню, импорт >5 МБ, мобильная вёрстка.
3. `manifest.json` `version` → `0.9.3`; футер `settings.html` → тот же текст (проверяется новым тестом из Fix 10e).
4. Обновить README (команды не менялись — проверить, что раздел «Usage» актуален) и USER_GUIDE (Clean + лимиты импорта).
5. Упаковка по списку исключений из README (`test/`, `scripts/`, `CODE_REVIEW.md`, `FIX_PLAN.md` не входят в дистрибутив).
