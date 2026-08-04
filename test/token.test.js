import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractAccessToken, extractScriptContent, unescapeHtml } from '../src/token.js';

const html = `<!DOCTYPE html>
<html><body>
<div id="app"></div>
<script id="script" src="/js/dist/waiting_customer.js?ver=3.2"
        data-content="{&quot;api_url&quot;:&quot;\\/\\/api.junbanmachi.jp&quot;,&quot;shop&quot;:{&quot;id&quot;:4268,&quot;name&quot;:&quot;\\u76db\\u5ca1&quot;},&quot;access_token&quot;:&quot;kVgo1jReHDlhlQ9L&quot;}"
></script>
</body></html>`;

describe('unescapeHtml', () => {
  it('名前付き実体と数値実体を戻す', () => {
    assert.equal(unescapeHtml('&quot;a&quot; &amp; &lt;b&gt; &#39;c&#39; &#x41;'), '"a" & <b> \'c\' A');
  });

  it('未知の実体はそのまま残す', () => {
    assert.equal(unescapeHtml('&unknownentity;'), '&unknownentity;');
  });
});

describe('extractScriptContent', () => {
  it('data-content属性のJSON文字列を取り出す', () => {
    assert.ok(extractScriptContent(html).startsWith('{"api_url"'));
  });

  it('data-contentがなければ例外を投げる', () => {
    assert.throws(() => extractScriptContent('<html></html>'), /data-content/);
  });
});

describe('extractAccessToken', () => {
  it('access_tokenとshop情報を取り出す', () => {
    const result = extractAccessToken(html);
    assert.equal(result.accessToken, 'kVgo1jReHDlhlQ9L');
    assert.equal(result.shop.id, 4268);
    assert.equal(result.apiUrl, '//api.junbanmachi.jp');
  });

  it('access_tokenが空なら例外を投げる', () => {
    const withoutToken = html.replace('&quot;access_token&quot;:&quot;kVgo1jReHDlhlQ9L&quot;', '&quot;other&quot;:1');
    assert.throws(() => extractAccessToken(withoutToken), /access_token/);
  });
});
