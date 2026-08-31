import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const stylePath = new URL('../style.css', import.meta.url);

test('preserves comments window layering contract', async () => {
    const css = await readFile(stylePath, 'utf8');

    const windowRule = css.match(/#dscWindow\s*\{([\s\S]*?)\n\}/);
    assert.ok(windowRule, '#dscWindow rule should exist');
    assert.match(windowRule[1], /z-index:\s*2999;/, '#dscWindow should remain at z-index 2999');
    assert.match(
        windowRule[1],
        /\/\*[^*]*host panels and modals above the comments window[^*]*\*\//,
        '#dscWindow should explain that host panels and modals remain above it',
    );

    for (const selector of ['.dsc_qs_menu', '.dsc_popover']) {
        const rule = css.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\n\\}`));
        assert.ok(rule, `${selector} rule should exist`);
        assert.match(rule[1], /z-index:\s*3500;/, `${selector} should remain at z-index 3500`);
    }

    assert.match(
        css,
        /\.popup,\s*#dialogue_popup,\s*#shadow_popup\s*\{\s*z-index:\s*4000\s*!important;\s*\}/,
        'host popup override should remain at z-index 4000 !important',
    );
});
