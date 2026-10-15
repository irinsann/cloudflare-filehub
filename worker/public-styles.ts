export const publicCss = `
:root{color-scheme:light;--bg:#f4f5f1;--fg:#23352c;--muted:#6d786e;--line:#dfe4dc;--card:#fff;--subtle:#edf1e9;--accent:#356349;--on-accent:#fff;--danger:#a64139;--shadow:0 16px 44px #183b2407,0 2px 5px #183b2405;--code-bg:#1b2922;--code-fg:#e3ebe4}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-padding-top:28px}
body{margin:0;min-height:100dvh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
::selection{background:var(--accent);color:var(--on-accent)}
a{color:var(--accent);text-decoration:none;text-underline-offset:4px}
a:hover{text-decoration:underline}
button,input{font:inherit}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;padding:9px 17px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--fg);font-size:13px;font-weight:550;line-height:1.5;cursor:pointer}
button:hover{background:var(--subtle)}
button:disabled{opacity:.55;cursor:wait}
.button{border-color:var(--accent);background:var(--accent);color:var(--on-accent);text-decoration:none;box-shadow:0 2px 4px #183b2410}
.button:hover{text-decoration:none;filter:brightness(.96)}
input{width:100%;min-width:0;min-height:46px;padding:11px 13px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--fg);font-size:16px}
input::placeholder{color:var(--muted);opacity:.85}
:where(button,a,input,summary):focus-visible{outline:2px solid var(--accent);outline-offset:3px}
input:focus-visible{outline-offset:1px}
.top{flex:none;width:calc(100% - 48px);max-width:1140px;min-height:66px;margin:24px auto 0;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid var(--line);border-radius:16px;background:var(--card);box-shadow:var(--shadow)}
.brand{display:inline-flex;align-items:center;gap:11px;color:var(--fg);font-size:19px;font-weight:650;letter-spacing:-.55px;line-height:1}
.brand svg{flex:none;width:29px;height:29px}
#theme{width:38px;min-height:38px;padding:9px;border-color:transparent;background:transparent;color:var(--muted)}
#theme:hover{background:var(--subtle);color:var(--fg)}
#theme svg{width:18px;height:18px}
.layout{width:100%;max-width:1188px;margin:36px auto 0;padding:0 24px;display:grid;grid-template-columns:minmax(0,840px) minmax(170px,1fr);gap:32px;align-items:start}
.layout.reader-only{max-width:888px;grid-template-columns:minmax(0,1fr)}
.reader{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:52px clamp(32px,5vw,64px);box-shadow:var(--shadow)}
.title{font-size:clamp(30px,3.2vw,42px);line-height:1.35;font-weight:650;letter-spacing:-1.25px;margin:0 0 20px;overflow-wrap:anywhere;text-wrap:balance}
.description{margin:0 0 24px;color:var(--muted);font-size:16px;line-height:1.85}
.description:empty{display:none}
.meta{display:flex;flex-wrap:wrap;gap:8px 20px;margin-bottom:36px;padding-bottom:28px;border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;letter-spacing:.15px}
.prose{overflow-wrap:anywhere;font-size:16px;line-height:1.95}
.prose>:first-child{margin-top:0}
.prose>:last-child{margin-bottom:0}
.prose h1,.prose h2,.prose h3,.prose h4{line-height:1.45;letter-spacing:-.5px;scroll-margin-top:28px;font-weight:650}
.prose h1{font-size:1.85em}
.prose h2{font-size:1.5em;margin:2.1em 0 .8em;padding-bottom:.5em;border-bottom:1px solid var(--line)}
.prose h3{font-size:1.2em;margin-top:1.9em}
.prose p{margin:1.25em 0}
.prose a{text-decoration:underline;text-decoration-thickness:1px}
.prose img{display:block;max-width:100%;height:auto;margin:28px auto;border-radius:10px}
.prose pre{position:relative;overflow:auto;margin:28px 0;padding:44px 22px 22px;border:1px solid #34483a;border-radius:12px;background:var(--code-bg);color:var(--code-fg);font-size:13px;line-height:1.85;tab-size:2}
.prose code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
.prose :not(pre)>code{padding:2px 5px;background:var(--subtle);border:1px solid var(--line);border-radius:5px;font-size:.85em}
.prose table{display:block;max-width:100%;overflow:auto;margin:28px 0;border-collapse:collapse;font-size:14px}
.prose th,.prose td{border:1px solid var(--line);padding:10px 14px;text-align:left}
.prose th{background:var(--subtle);font-weight:600}
.prose blockquote{margin:28px 0;padding:1px 22px;border-left:2px solid var(--accent);background:var(--subtle);color:var(--muted)}
.prose hr{border:0;border-top:1px solid var(--line);margin:36px 0}
.prose ul,.prose ol{padding-left:1.6em}
.prose li{margin:.3em 0}
.prose input[type=checkbox]{width:auto;min-height:0;margin-right:6px;accent-color:var(--accent)}
.toc{position:sticky;top:24px;min-width:0;padding:12px 0 12px 20px;border-left:1px solid var(--line);font-size:12px}
.toc details>summary{display:flex;align-items:center;min-height:40px;font-weight:600;letter-spacing:.35px;list-style:none;cursor:pointer}
.toc details>summary::-webkit-details-marker{display:none}
.toc nav{max-height:calc(100dvh - 128px);overflow:auto;padding-right:6px}
.toc a{display:block;color:var(--muted);line-height:1.65;margin:14px 0;overflow-wrap:anywhere}
.toc a:hover{color:var(--accent)}
.hljs-keyword,.hljs-selector-tag{color:#d7c2a6}
.hljs-string,.hljs-attr{color:#b4d5ab}
.hljs-number,.hljs-literal{color:#efc68f}
.hljs-comment{color:#a2b0a5}
.copy{position:absolute;top:8px;right:8px;min-height:28px;padding:4px 9px;border-color:#46594a;border-radius:6px;background:#2b3c30;color:var(--code-fg);font-size:10px}
.copy:hover{background:#3a4e40}
.card{width:calc(100% - 48px);max-width:760px;margin:48px auto 0;padding:36px;border:1px solid var(--line);border-radius:18px;background:var(--card);box-shadow:var(--shadow)}
.card h1{margin:0 0 12px;font-size:27px;line-height:1.4;letter-spacing:-.65px;overflow-wrap:anywhere}
.card p{color:var(--muted);overflow-wrap:anywhere}
.share-heading{display:flex;align-items:center;gap:18px;margin-bottom:28px}
.share-heading>div{min-width:0}
.share-symbol{display:grid;place-items:center;flex:none;width:52px;height:56px;border:1px solid var(--line);border-radius:12px;background:var(--subtle);color:var(--accent)}
.share-symbol svg{width:24px;height:24px}
.share-heading h1{margin:0 0 6px;font-size:23px}
.share-heading p{margin:0;font-size:12px}
#unlock{display:flex;gap:10px;padding-top:28px;border-top:1px solid var(--line)}
#unlock input{flex:1}
#unlock button{flex:none;min-width:88px;border-color:var(--accent);background:var(--accent);color:var(--on-accent)}
#view:empty{display:none}
#view{overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--subtle)}
#view img,#view video,#view iframe{display:block;width:100%;max-height:65dvh;border:0;object-fit:contain}
#view iframe{height:65dvh}
#view audio{display:block;width:100%;margin:16px 0}
#view pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:65dvh;overflow:auto;margin:0;padding:22px;font:13px/1.85 "SFMono-Regular",Consolas,monospace}
.share-actions{margin-top:28px;display:flex;justify-content:flex-end}
.share-actions:has([hidden]){display:none}
.error{color:var(--danger)}
footer{margin-top:auto;padding:44px 24px max(24px,env(safe-area-inset-bottom));text-align:center;color:var(--muted);font-size:10px;letter-spacing:1px}
@media(prefers-color-scheme:dark){html:not([data-theme=light]){color-scheme:dark;--bg:#151d18;--fg:#e6ece4;--muted:#a0ada1;--line:#344139;--card:#1d2821;--subtle:#26342b;--accent:#b4cea6;--on-accent:#162b1c;--danger:#edaaa1;--shadow:0 16px 44px #050d081c,0 2px 6px #050d0812;--code-bg:#111b15}}
html[data-theme=dark]{color-scheme:dark;--bg:#151d18;--fg:#e6ece4;--muted:#a0ada1;--line:#344139;--card:#1d2821;--subtle:#26342b;--accent:#b4cea6;--on-accent:#162b1c;--danger:#edaaa1;--shadow:0 16px 44px #050d081c,0 2px 6px #050d0812;--code-bg:#111b15}
@media(max-width:900px){.layout{grid-template-columns:minmax(0,1fr);gap:16px;margin-top:26px}.reader{padding:36px}.toc{grid-row:1;position:static;padding:0 18px;border:1px solid var(--line);border-radius:12px;background:var(--card)}.toc details>summary{min-height:46px}.toc details>summary::after{content:"+";margin-left:auto;font-size:18px;font-weight:400;color:var(--muted)}.toc details[open]>summary::after{content:"−"}.toc nav{max-height:36dvh;margin:4px 0 16px}.title{font-size:32px}}
@media(max-width:600px){.top{width:calc(100% - 24px);min-height:60px;margin-top:12px;padding:10px 16px;border-radius:12px}.brand{font-size:18px}.brand svg{width:27px;height:27px}.layout{margin-top:20px;padding:0 max(12px,env(safe-area-inset-right)) 0 max(12px,env(safe-area-inset-left))}.reader{padding:28px 22px;border-radius:12px}.title{font-size:28px}.description,.prose{font-size:15px}.meta{margin-bottom:28px;padding-bottom:22px;gap:7px 14px}.prose pre{font-size:12px;padding:44px 14px 18px}.card{width:calc(100% - 24px);margin-top:24px;padding:24px 20px;border-radius:14px}.share-heading{gap:12px}.share-heading h1{font-size:20px}.share-symbol{width:44px;height:48px}#unlock{flex-direction:column}#unlock button{width:100%}.share-actions .button{width:100%}footer{padding-top:32px}}
@media(prefers-contrast:more){:root{--muted:#48574b;--line:#7a887c}html[data-theme=dark]{--muted:#c3cec4;--line:#819486}.top,.card,.reader{box-shadow:none}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;
