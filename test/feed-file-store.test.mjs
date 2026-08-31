// @ts-check
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import '../test-helpers/stub-runtime.mjs';
import { _resetFeedFileStore, _seedMirror, _flushWriteChain, _getLoadedKey, _STORE_VERSION,
    loadFeedStore, getFeedSlot, setFeedSlot, pruneOrphanedEntries, dropSlotEntry,
    clearFeedFile, feedStoreSnapshot, mergeImportedEntries, chatFileKey, hashKeyOf,
    slotKeyOf, hashFingerprint, feedStoreDiagnostics, flushFeedStoreWrites, noteChatRenamed,
    IMPORT_LIMITS } from '../src/feed-file-store.js';
import { resetCtx } from '../test-helpers/stub-runtime.mjs';

function makeMsg({ mes = 'ai reply', send_date = '2026-08-19T10:00:00.000Z', swipes = null, swipe_info = null, is_user = false } = {}) {
    return {
        name: 'Char',
        is_user, is_system: false, is_hidden: false,
        mes, send_date,
        swipes: swipes ?? [mes],
        swipe_id: 0,
        ...(swipe_info !== null ? { swipe_info } : {}),
    };
}

function slotInfo(sendDate, extra = {}) {
    return { send_date: sendDate, extra };
}

beforeEach(() => {
    resetCtx();
    globalThis._stFilesReset();
    _resetFeedFileStore();
});

describe('chat identity → file key', () => {
    test('guid in chatMetadata wins', () => {
        globalThis._stCtx.chatMetadata.dscomments_commentary = { guid: 'gabc123' };
        assert.equal(chatFileKey(), 'dsc_gabc123.json');
    });

    test('no guid → deterministic hash of character|group|chatId', () => {
        globalThis._stCtx.characterId = 3;
        globalThis._stCtx.chatId = 'my chat';
        const k1 = hashKeyOf();
        assert.equal(hashKeyOf(), k1);                                // stable
        globalThis._stCtx.chatId = 'other chat';
        assert.notEqual(hashKeyOf(), k1);                             // chat-sensitive
        // Same chat name across DIFFERENT characters must not collide:
        globalThis._stCtx.chatId = 'my chat';
        globalThis._stCtx.characterId = 7;
        assert.notEqual(hashKeyOf(), k1);
    });

    test('filename is valid for /api/files (alnum, underscore, dash, dot)', () => {
        globalThis._stCtx.chatMetadata.dscomments_commentary = { guid: 'gdeadbeef99' };
        assert.match(chatFileKey(), /^dsc_[a-z0-9]+\.json$/);
        assert.match(hashKeyOf(), /^dsc_[a-z0-9]+\.json$/);
    });
});

describe('loadFeedStore', () => {
    test('404 (no file) → empty mirror, no error', async () => {
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [makeMsg()];
        await loadFeedStore();
        assert.equal(feedStoreDiagnostics().result, 'missing');
        assert.deepEqual(feedStoreSnapshot().entries, {});
        assert.ok(feedStoreSnapshot().loaded);
    });

    test('existing file loads into mirror; reads are sync afterwards', async () => {
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chatMetadata.dscomments_commentary = { guid: 'gguid1' };
        const msg = makeMsg({ swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')] });
        globalThis._stCtx.chat = [msg];
        globalThis._stFiles['dsc_gguid1.json'] = JSON.stringify({
            v: _STORE_VERSION,
            entries: { '2026-08-19T10:00:00.000Z': { html: '<b>hi</b>', ts: 1, fp: hashFingerprint('ai reply'), generationFp: null } },
        });
        await loadFeedStore();
        assert.equal(getFeedSlot('0', 0)?.html, '<b>hi</b>');
        assert.equal(_getLoadedKey(), 'dsc_gguid1.json');
    });

    test('fresh guid adopts the pre-guid hash-key file', async () => {
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.characterId = 1;
        const msg = makeMsg({ swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')] });
        globalThis._stCtx.chat = [msg];
        const hashDoc = { v: _STORE_VERSION, entries: { '2026-08-19T10:00:00.000Z': { html: 'adopted', ts: 1 } } };
        globalThis._stFiles[hashKeyOf()] = JSON.stringify(hashDoc);
        await loadFeedStore();
        // guid got minted (no guid in metadata before), hash file was adopted
        assert.equal(getFeedSlot('0', 0)?.html, 'adopted');
    });

    test('fresh guid + adopted fallback: content is copied to the guid file and the fallback is retired', async () => {
        globalThis._stCtx.chatId = 'c-adopt';
        globalThis._stCtx.characterId = 2;
        // A live slot must hold the send_date, or GC would prune the entry.
        globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')] })];
        const fallbackKey = hashKeyOf();
        globalThis._stFiles[fallbackKey] = JSON.stringify({
            v: _STORE_VERSION,
            entries: { '2026-08-19T10:00:00.000Z': { v: _STORE_VERSION, html: 'adopted', ts: 1 } },
        });
        await loadFeedStore();
        await _flushWriteChain();

        const mainKey = _getLoadedKey();
        assert.notEqual(mainKey, fallbackKey, 'a fresh guid file must have been minted');
        const doc = JSON.parse(globalThis._stFiles[mainKey]);
        assert.equal(doc.entries['2026-08-19T10:00:00.000Z'].html, 'adopted', 'content copied under the guid key');
        assert.equal(globalThis._stFiles[fallbackKey], undefined, 'fallback file retired after the copy landed');
    });

    test('fallback retirement is skipped when the guid-file copy fails', async () => {
        globalThis._stCtx.chatId = 'c-adopt-fail';
        globalThis._stCtx.characterId = 3;
        const fallbackKey = hashKeyOf();
        globalThis._stFiles[fallbackKey] = JSON.stringify({
            v: _STORE_VERSION,
            entries: { '2026-08-19T10:00:00.000Z': { v: _STORE_VERSION, html: 'kept-here', ts: 1 } },
        });

        const origFetch = globalThis.fetch;
        globalThis.fetch = async (url, init = {}) => {
            if (String(url) === '/api/files/upload') return { ok: false, status: 500, text: async () => 'boom' };
            return origFetch(url, init);
        };
        try {
            await loadFeedStore();
            await _flushWriteChain();
        } finally {
            globalThis.fetch = origFetch;
        }
        assert.ok(globalThis._stFiles[fallbackKey] !== undefined, 'fallback stays as the surviving store');
    });

    test('network failure → empty mirror, session continues', async () => {
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [makeMsg()];
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error('boom'); };
        try {
            await loadFeedStore();
        } finally { globalThis.fetch = origFetch; }
        assert.equal(getFeedSlot('0', 0), null);
    });

    test('stale slow load cannot replace a newer chat mirror', async () => {
        const originalFetch = globalThis.fetch;
        let releaseOld;
        const oldRead = new Promise(resolve => { releaseOld = resolve; });
        globalThis.fetch = async (url, init) => {
            const name = decodeURIComponent(String(url).split('/').pop());
            if (name === 'dsc_old.json') {
                await oldRead;
                return { ok: true, status: 200, text: async () => JSON.stringify({ v: _STORE_VERSION, entries: { old: { html: 'old' } } }) };
            }
            return originalFetch(url, init);
        };
        try {
            globalThis._stCtx.chatId = 'old-chat';
            globalThis._stCtx.chatMetadata.dscomments_commentary = { guid: 'old' };
            globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo('old')] })];
            const oldLoad = loadFeedStore();
            await Promise.resolve();

            globalThis._stCtx.chatId = 'new-chat';
            globalThis._stCtx.chatMetadata = { dscomments_commentary: { guid: 'new' } };
            globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo('new')] })];
            const newLoad = loadFeedStore();
            await newLoad;
            releaseOld();
            await oldLoad;
            assert.equal(_getLoadedKey(), 'dsc_new.json');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test('no chatId (start screen) → mirror dropped', async () => {
        globalThis._stCtx.chatId = null;
        await loadFeedStore();
        assert.equal(feedStoreSnapshot().loaded, false);
    });
});

describe('checkpoint / branch isolation', () => {
    test('branch gets a new file and copies only live parent slots', async () => {
        const shared = '2026-08-19T10:00:00.000Z';
        const parentOnly = '2026-08-19T11:00:00.000Z';
        globalThis._stCtx.chatId = 'parent-chat';
        globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo(shared), slotInfo(parentOnly)] })];
        globalThis._stCtx.chatMetadata.dscomments_commentary = { guid: 'parent-guid' };
        globalThis._stFiles['dsc_parent-guid.json'] = JSON.stringify({
            v: _STORE_VERSION,
            entries: {
                [shared]: { html: 'shared comment', ts: 1, fp: hashFingerprint('ai reply') },
                [parentOnly]: { html: 'parent-only comment', ts: 2, fp: hashFingerprint('ai reply') },
            },
        });
        await loadFeedStore();

        globalThis._stCtx.chatId = 'branch-chat';
        globalThis._stCtx.chatMetadata = {
            main_chat: 'parent-chat',
            dscomments_commentary: { guid: 'parent-guid' },
        };
        globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo(shared)] })];
        await loadFeedStore();

        const branchGuid = globalThis._stCtx.chatMetadata.dscomments_commentary.guid;
        assert.notEqual(branchGuid, 'parent-guid');
        assert.equal(_getLoadedKey(), `dsc_${branchGuid}.json`);
        assert.equal(getFeedSlot('0', 0)?.html, 'shared comment');
        assert.equal(feedStoreSnapshot().entries[parentOnly], undefined);
        await flushFeedStoreWrites();

        const parentDoc = JSON.parse(globalThis._stFiles['dsc_parent-guid.json']);
        assert.equal(parentDoc.entries[parentOnly].html, 'parent-only comment');
        const branchDoc = JSON.parse(globalThis._stFiles[`dsc_${branchGuid}.json`]);
        assert.equal(branchDoc.entries[shared].html, 'shared comment');
        assert.equal(branchDoc.entries[parentOnly], undefined);
    });

    test('reopening an isolated branch is idempotent', async () => {
        globalThis._stCtx.chatId = 'branch-chat';
        globalThis._stCtx.chatMetadata = {
            main_chat: 'parent-chat',
            dscomments_commentary: { guid: 'parent-guid' },
        };
        globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')] })];
        globalThis._stFiles['dsc_parent-guid.json'] = JSON.stringify({ v: _STORE_VERSION, entries: {} });
        await loadFeedStore();
        const guid = globalThis._stCtx.chatMetadata.dscomments_commentary.guid;
        assert.notEqual(guid, 'parent-guid');

        _resetFeedFileStore();
        await loadFeedStore();
        assert.equal(globalThis._stCtx.chatMetadata.dscomments_commentary.guid, guid);
        assert.equal(_getLoadedKey(), `dsc_${guid}.json`);
    });

    test('checkpoint without inherited guid creates an isolated empty store', async () => {
        globalThis._stCtx.chatId = 'checkpoint-chat';
        globalThis._stCtx.chatMetadata = { main_chat: 'parent-chat' };
        globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')] })];
        await loadFeedStore();
        const meta = globalThis._stCtx.chatMetadata.dscomments_commentary;
        assert.ok(meta.guid);
        assert.equal(meta.forkParentGuid, undefined);
        assert.equal(feedStoreSnapshot().entries['2026-08-19T10:00:00.000Z'], undefined);
    });

    test('CHAT_RENAMED updates fork marker without changing its guid', async () => {
        globalThis._stCtx.chatId = 'branch-one';
        globalThis._stCtx.chatMetadata = {
            main_chat: 'parent-chat',
            dscomments_commentary: { guid: 'branch-guid', forkHandled: true, forkChatId: 'branch-one' },
        };
        assert.equal(noteChatRenamed({ oldFileName: 'branch-one.jsonl', newFileName: 'branch-renamed.jsonl' }), true);
        assert.equal(globalThis._stCtx.chatMetadata.dscomments_commentary.guid, 'branch-guid');
        assert.equal(globalThis._stCtx.chatMetadata.dscomments_commentary.forkChatId, 'branch-renamed');
    });

    test('nested branch gets a fresh guid after the source branch is renamed', async () => {
        globalThis._stCtx.chatId = 'branch-one';
        globalThis._stCtx.chatMetadata = {
            main_chat: 'parent-chat',
            dscomments_commentary: { guid: 'parent-guid' },
        };
        globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')] })];
        globalThis._stFiles['dsc_parent-guid.json'] = JSON.stringify({ v: _STORE_VERSION, entries: {} });
        await loadFeedStore();
        const branchGuid = globalThis._stCtx.chatMetadata.dscomments_commentary.guid;
        const branchMeta = globalThis._stCtx.chatMetadata.dscomments_commentary;
        assert.notEqual(branchGuid, 'parent-guid');
        assert.equal(branchMeta.forkChatId, 'branch-one');

        branchMeta.forkChatId = 'branch-one-renamed';
        globalThis._stCtx.chatId = 'branch-one-renamed';
        _resetFeedFileStore();
        await loadFeedStore();
        assert.equal(globalThis._stCtx.chatMetadata.dscomments_commentary.guid, branchGuid);

        globalThis._stCtx.chatId = 'branch-two';
        globalThis._stCtx.chatMetadata = {
            main_chat: 'branch-one-renamed',
            dscomments_commentary: { ...globalThis._stCtx.chatMetadata.dscomments_commentary },
        };
        await loadFeedStore();
        const nestedGuid = globalThis._stCtx.chatMetadata.dscomments_commentary.guid;
        assert.notEqual(nestedGuid, branchGuid);
        assert.equal(_getLoadedKey(), `dsc_${nestedGuid}.json`);
    });
});

describe('slot keys', () => {
    test('slot send_date preferred over message send_date', () => {
        const msg = makeMsg({
            send_date: '2026-08-19T09:00:00.000Z',
            swipes: ['a', 'b'],
            swipe_info: [slotInfo('2026-08-19T09:00:00.000Z'), slotInfo('2026-08-19T11:00:00.000Z')],
        });
        assert.equal(slotKeyOf(msg, 0), '2026-08-19T09:00:00.000Z');
        assert.equal(slotKeyOf(msg, 1), '2026-08-19T11:00:00.000Z');
    });

    test('no swipe_info → message send_date fallback', () => {
        const msg = makeMsg({ send_date: '2026-08-01T00:00:00.000Z' });
        assert.equal(slotKeyOf(msg, 0), '2026-08-01T00:00:00.000Z');
    });
});

describe('setFeedSlot / getFeedSlot', () => {
    test('write → mirror + upload; reload round-trips', async () => {
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [makeMsg({
            swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')],
        })];
        await loadFeedStore();
        assert.equal(setFeedSlot('0', 0, '<i>комментарий</i>', 'genfp1'), true);
        await _flushWriteChain();
        const raw = globalThis._stFiles['dsc_' + globalThis._stCtx.chatMetadata.dscomments_commentary.guid + '.json'];
        assert.ok(raw, 'file uploaded');
        const doc = JSON.parse(raw);
        assert.equal(doc.entries['2026-08-19T10:00:00.000Z'].html, '<i>комментарий</i>');
        assert.equal(doc.entries['2026-08-19T10:00:00.000Z'].generationFp, 'genfp1');

        // Fresh load (new session) sees it:
        _resetFeedFileStore();
        await loadFeedStore();
        assert.equal(getFeedSlot('0', 0)?.html, '<i>комментарий</i>');
    });

    test('cyrillic html survives base64 round-trip', async () => {
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [makeMsg({ mes: 'привет', swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')] })];
        await loadFeedStore();
        setFeedSlot('0', 0, '<div>Комментарий зрителя №1</div>');
        await _flushWriteChain();
        _resetFeedFileStore();
        await loadFeedStore();
        assert.equal(getFeedSlot('0', 0)?.html, '<div>Комментарий зрителя №1</div>');
    });

    test('fp-scan rescues legacy same-send_date collisions', async () => {
        // Two swipes backfilled with ONE shared send_date (ensureSwipesValid):
        const msg = makeMsg({
            mes: 'b-text',
            swipes: ['a-text', 'b-text'],
            swipe_info: [slotInfo('2026-08-19T10:00:00.000Z'), slotInfo('2026-08-19T10:00:00.000Z')],
        });
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [msg];
        globalThis._stCtx.chatMetadata.dscomments_commentary = { guid: 'gg' };
        globalThis._stFiles['dsc_gg.json'] = JSON.stringify({
            v: _STORE_VERSION,
            entries: {
                '2026-08-19T10:00:00.000Z': { html: 'feed-for-a', ts: 1, fp: hashFingerprint('a-text') },
            },
        });
        await loadFeedStore();
        // Direct key holds the payload for swipe 0 (fp matches a-text):
        assert.equal(getFeedSlot('0', 0)?.html, 'feed-for-a');
        // Swipe 1 (b-text): direct key fp mismatches → scan finds it was the
        // same entry; both share it (collisions converge, never misattribute):
        assert.equal(getFeedSlot('0', 1)?.html, 'feed-for-a');
    });

    test('unknown message or mirror-less store → null/false', async () => {
        globalThis._stCtx.chatId = 'c1';
        await loadFeedStore();
        assert.equal(getFeedSlot('99', 0), null);
        _resetFeedFileStore();
        assert.equal(setFeedSlot('0', 0, 'x'), false);
        assert.equal(getFeedSlot('0', 0), null);
    });
});

describe('GC', () => {
    test('load prunes keys of dead slots, keeps live ones', async () => {
        const msg = makeMsg({
            swipes: ['a', 'b'],
            swipe_info: [slotInfo('2026-08-19T10:00:00.000Z'), slotInfo('2026-08-19T11:00:00.000Z')],
        });
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [msg];
        globalThis._stCtx.chatMetadata.dscomments_commentary = { guid: 'gg' };
        globalThis._stFiles['dsc_gg.json'] = JSON.stringify({
            v: _STORE_VERSION,
            entries: {
                '2026-08-19T10:00:00.000Z': { html: 'live', ts: 1 },
                '2026-08-19T12:00:00.000Z': { html: 'dead', ts: 2 },      // deleted swipe
                '2026-08-01T00:00:00.000Z': { html: 'dead-msg', ts: 3 },  // deleted message
            },
        });
        await loadFeedStore();
        // GC ran during load (CHAT_CHANGED path):
        assert.deepEqual(Object.keys(feedStoreSnapshot().entries), ['2026-08-19T10:00:00.000Z']);
        // Idempotent — a manual pass finds nothing more to drop:
        assert.equal(pruneOrphanedEntries(), 0);
    });

    test('dropSlotEntry by explicit dead key (swipe deleted → splice already happened)', async () => {
        const msg = makeMsg({
            swipes: ['a', 'b'],
            swipe_info: [slotInfo('2026-08-19T10:00:00.000Z'), slotInfo('2026-08-19T11:00:00.000Z')],
        });
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [msg];
        await loadFeedStore();
        setFeedSlot('0', 0, 'one');
        setFeedSlot('0', 1, 'two');
        await _flushWriteChain();
        // ST spliced swipe 1 away: its key is only known from the event's dead slot.
        assert.equal(dropSlotEntry(null, null, '2026-08-19T11:00:00.000Z'), true);
        await _flushWriteChain();
        _resetFeedFileStore();
        await loadFeedStore();
        assert.equal(getFeedSlot('0', 0)?.html, 'one');
        assert.equal(feedStoreSnapshot().entries['2026-08-19T11:00:00.000Z'], undefined);
    });
});

describe('clear and merge', () => {
    test('clearFeedFile empties mirror and deletes the server file', async () => {
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')] })];
        await loadFeedStore();
        setFeedSlot('0', 0, 'x');
        await _flushWriteChain();
        clearFeedFile();
        await _flushWriteChain();
        assert.deepEqual(feedStoreSnapshot().entries, {});
        assert.equal(globalThis._stFiles[_getLoadedKey()], undefined);
    });

    test('mergeImportedEntries keeps newer ts, rejects garbage', async () => {
        globalThis._stCtx.chatId = 'c1';
        await loadFeedStore();
        _seedMirror({ k1: { html: 'old', ts: 100 } });
        const { merged } = mergeImportedEntries({ entries: {
            k1: { html: 'newer', ts: 200 },
            k2: { html: 'added', ts: 50 },
            bad: { nothtml: true },
        } });
        assert.equal(merged, 2);
        assert.equal(feedStoreSnapshot().entries.k1.html, 'newer');
        assert.equal(feedStoreSnapshot().entries.k2.html, 'added');
        assert.equal(feedStoreSnapshot().entries.bad, undefined);
    });

    test('mergeImportedEntries skips oversized html entries and reports the count', async () => {
        globalThis._stCtx.chatId = 'c1';
        await loadFeedStore();
        const big = 'x'.repeat(IMPORT_LIMITS.maxEntryHtmlChars + 1);
        const ok = 'y'.repeat(IMPORT_LIMITS.maxEntryHtmlChars);
        const { merged, skipped } = mergeImportedEntries({ entries: {
            big1: { html: big, ts: 200 },
            ok1: { html: ok, ts: 200 },
        } });
        assert.equal(merged, 1, 'the at-limit entry is accepted');
        assert.equal(skipped, 1, 'the over-limit entry is skipped and reported');
        assert.equal(feedStoreSnapshot().entries.big1, undefined);
        assert.equal(feedStoreSnapshot().entries.ok1.html, ok);
    });

    test('mergeImportedEntries stops accepting beyond maxEntries', async () => {
        globalThis._stCtx.chatId = 'c1';
        await loadFeedStore();
        const entries = {};
        for (let i = 0; i < IMPORT_LIMITS.maxEntries + 5; i++) entries[`k${i}`] = { html: `h${i}`, ts: 1 };
        const { merged, skipped } = mergeImportedEntries({ entries });
        assert.equal(merged, IMPORT_LIMITS.maxEntries);
        assert.equal(skipped, 5);
    });
});

describe('v1 migration (chatMetadata.posts)', () => {
    test('posts lifted by send_date, table stripped only after upload', async () => {
        const msg = makeMsg({
            swipes: ['a-text', 'b-text'],
            swipe_info: [slotInfo('2026-08-19T10:00:00.000Z'), slotInfo('2026-08-19T11:00:00.000Z')],
        });
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [msg];
        globalThis._stCtx.chatMetadata.dscomments_commentary = {
            posts: {
                '0': {
                    '0': { html: 'feed-a', timestamp: 111, fp: hashFingerprint('a-text'), generationFp: 'g1' },
                    '1': { html: 'feed-b', timestamp: 222 },
                },
            },
            current: { msgId: '0', swipeIdx: 1 },
        };
        await loadFeedStore();
        await _flushWriteChain();
        // Stripped from chatMetadata after the write landed:
        assert.equal(globalThis._stCtx.chatMetadata.dscomments_commentary.posts, undefined);
        // Readable via the new keying:
        assert.equal(getFeedSlot('0', 0)?.html, 'feed-a');
        assert.equal(getFeedSlot('0', 1)?.html, 'feed-b');
        assert.equal(getFeedSlot('0', 0)?.generationFp, 'g1');
        // …and present in the uploaded file:
        const doc = JSON.parse(globalThis._stFiles[_getLoadedKey()]);
        assert.equal(doc.entries['2026-08-19T10:00:00.000Z'].html, 'feed-a');
    });

    test('upload failure keeps posts in chatMetadata for retry', async () => {
        globalThis._stCtx.chatId = 'c1';
        globalThis._stCtx.chat = [makeMsg({ swipe_info: [slotInfo('2026-08-19T10:00:00.000Z')] })];
        globalThis._stCtx.chatMetadata.dscomments_commentary = {
            posts: { '0': { '0': { html: 'feed', timestamp: 1 } } },
        };
        const origFetch = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error('server down'); };
        await loadFeedStore();          // read fails → empty mirror… but migration
        // still lifted nothing (mirror empty + read failed). Reload with fetch up:
        globalThis.fetch = origFetch;
        _resetFeedFileStore();
        await loadFeedStore();
        await _flushWriteChain();
        assert.equal(getFeedSlot('0', 0)?.html, 'feed');
    });
});
