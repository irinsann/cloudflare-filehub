export const publicCss = `
:root{color-scheme:light;--bg:#f7f5f2;--fg:#342f43;--muted:#756e83;--line:#e7e2eb;--card:#fffeff;--subtle:#f5f1f9;--accent:#7961ad;--on-accent:#fff;--danger:#ac405b;--glass:rgba(255,255,255,.78);--reader-surface:rgba(255,255,255,.95);--glass-edge:rgba(255,255,255,.9);--glass-shadow:0 16px 42px #213c6810,0 3px 10px #213c6807,inset 0 1px 0 #ffffffdb;--glow-blue:#eadcf080;--glow-violet:#f9e8de90}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-padding-top:24px}
body{margin:0;min-height:100dvh;display:flex;flex-direction:column;background:radial-gradient(ellipse 780px 560px at 0% 0%,var(--glow-blue),transparent 72%),radial-gradient(ellipse 680px 520px at 100% 8%,var(--glow-violet),transparent 72%),var(--bg);background-repeat:no-repeat;color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none;text-underline-offset:3px}
a:hover{text-decoration:underline}
button,input{font:inherit}
button,.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;padding:9px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);font-size:13px;font-weight:500;line-height:1.5;cursor:pointer}
button:hover{background:var(--subtle)}
button:disabled{opacity:.55;cursor:wait}
.button{border-color:var(--accent);background:var(--accent);color:var(--on-accent);text-decoration:none}
.button:hover{text-decoration:none;filter:brightness(.96)}
input{width:100%;min-width:0;min-height:44px;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);font-size:16px}
input::placeholder{color:var(--muted)}
:where(button,a,input,summary):focus-visible{outline:2px solid var(--accent);outline-offset:3px}
input:focus-visible{outline-offset:1px}
.top{flex:none;width:calc(100% - 40px);max-width:1180px;min-height:68px;margin:20px auto 0;padding:12px 22px;display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid var(--line);border-radius:22px;background:var(--card);box-shadow:var(--glass-shadow)}
.top-actions{display:flex;align-items:center;gap:8px}#language{min-width:70px;background:var(--subtle);border-color:transparent;border-radius:14px}.brand{display:inline-flex;align-items:center;gap:10px;color:var(--fg);font-size:19px;font-weight:650;letter-spacing:-.6px;line-height:1}
.brand svg{flex:none;width:30px;height:30px}
#theme{width:40px;min-height:40px;padding:9px;border-color:transparent;border-radius:14px;background:transparent;color:var(--muted)}
#theme:hover{background:var(--subtle);color:var(--fg)}
#theme svg{width:19px;height:19px}
.layout{width:100%;max-width:1212px;margin:32px auto 0;padding:0 28px;display:grid;grid-template-columns:minmax(0,850px) minmax(160px,1fr);gap:28px;align-items:start}
.layout.reader-only{max-width:906px;grid-template-columns:minmax(0,1fr)}
.reader{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:24px;padding:44px 48px;box-shadow:var(--glass-shadow)}
.title{font-size:clamp(28px,3vw,38px);line-height:1.35;font-weight:650;letter-spacing:-1.1px;margin:0 0 16px;overflow-wrap:anywhere}
.description{margin:0 0 18px;color:var(--muted);font-size:16px}
.description:empty{display:none}
.meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid var(--line);color:var(--muted);font-size:12px}
.prose{overflow-wrap:anywhere;font-size:16px;line-height:1.9}
.prose>:first-child{margin-top:0}
.prose>:last-child{margin-bottom:0}
.prose h1,.prose h2,.prose h3,.prose h4{line-height:1.45;letter-spacing:-.4px;scroll-margin-top:24px}
.prose h1{font-size:1.75em}
.prose h2{font-size:1.45em;margin-top:2em;padding-bottom:.45em;border-bottom:1px solid var(--line)}
.prose h3{font-size:1.2em;margin-top:1.8em}
.prose a{text-decoration:underline}
.prose img{display:block;max-width:100%;height:auto;margin:24px auto;border-radius:6px}
.prose pre{position:relative;overflow:auto;margin:24px 0;padding:44px 20px 20px;border:1px solid #303744;border-radius:8px;background:#20252f;color:#e8edf5;font-size:13px;line-height:1.7;tab-size:2}
.prose code{font-family:"Cascadia Code",Consolas,monospace}
.prose :not(pre)>code{padding:2px 5px;background:var(--subtle);border:1px solid var(--line);border-radius:4px;font-size:.86em}
.prose table{display:block;max-width:100%;overflow:auto;margin:24px 0;border-collapse:collapse;font-size:14px}
.prose th,.prose td{border:1px solid var(--line);padding:9px 14px;text-align:left}
.prose th{background:var(--subtle);font-weight:600}
.prose blockquote{margin:24px 0;padding:2px 20px;border-left:3px solid var(--accent);color:var(--muted)}
.prose hr{border:0;border-top:1px solid var(--line);margin:32px 0}
.prose ul,.prose ol{padding-left:1.6em}
.prose input[type=checkbox]{width:auto;min-height:0;margin-right:6px;accent-color:var(--accent)}
.toc{position:sticky;top:20px;min-width:0;padding:12px 16px;border:1px solid var(--line);border-radius:20px;background:var(--card);box-shadow:var(--glass-shadow);font-size:12px}
.toc details>summary{display:flex;align-items:center;min-height:40px;font-weight:600;list-style:none;cursor:pointer}
.toc details>summary::-webkit-details-marker{display:none}
.toc nav{max-height:calc(100dvh - 124px);overflow:auto;border-left:1px solid var(--line);padding-left:16px}
.toc a{display:block;color:var(--muted);line-height:1.6;margin:12px 0;overflow-wrap:anywhere}
.toc a:hover{color:var(--accent)}
.hljs-keyword,.hljs-selector-tag{color:#c5b3f6}
.hljs-string,.hljs-attr{color:#a7d5bd}
.hljs-number,.hljs-literal{color:#ecc18e}
.hljs-comment{color:#9aa7ba}
.copy{position:absolute;top:8px;right:8px;min-height:28px;padding:3px 9px;border-color:#465063;border-radius:5px;background:#2c3441;color:#dfe7f4;font-size:11px}
.copy:hover{background:#3b4657}
.card{width:calc(100% - 48px);max-width:760px;margin:40px auto 0;padding:32px;border:1px solid var(--line);border-radius:24px;background:var(--card);box-shadow:var(--glass-shadow)}
.card h1{margin:0 0 12px;font-size:25px;line-height:1.4;letter-spacing:-.6px;overflow-wrap:anywhere}
.card p{color:var(--muted);overflow-wrap:anywhere}
.share-heading{display:flex;align-items:center;gap:14px;margin-bottom:24px}
.share-heading>div{min-width:0}
.share-symbol{display:grid;place-items:center;flex:none;width:44px;height:44px;border:1px solid var(--line);border-radius:14px;background:var(--subtle);color:var(--accent)}
.share-symbol svg{width:22px;height:22px}
.share-heading h1{margin:0 0 4px;font-size:22px}
.share-heading p{margin:0;font-size:12px}
#unlock{display:flex;gap:10px;padding-top:24px;border-top:1px solid var(--line)}
#unlock input{flex:1}
#unlock button{flex:none;min-width:80px;border-color:var(--accent);background:var(--accent);color:var(--on-accent)}
#view:empty{display:none}
#view{overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--subtle)}
#view img,#view video,#view iframe{display:block;width:100%;max-height:65dvh;border:0;object-fit:contain}
#view iframe{height:65dvh}
#view audio{display:block;width:100%;margin:16px 0}
#view pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:65dvh;overflow:auto;margin:0;padding:20px;font:13px/1.8 "Cascadia Code",Consolas,monospace}
.share-actions{margin-top:24px;display:flex;justify-content:flex-end}
.share-actions:has([hidden]){display:none}
.error{color:var(--danger)}
footer{margin-top:auto;padding:40px 24px 24px;text-align:center;color:var(--muted);font-size:11px;letter-spacing:.2px}
@media(prefers-color-scheme:dark){html:not([data-theme=light]){color-scheme:dark;--bg:#211f28;--fg:#f0ebf4;--muted:#b7adc2;--line:#45404f;--card:#2c2935;--subtle:#393341;--accent:#d0b6f0;--on-accent:#30203f;--danger:#f2a6b4;--glass:rgba(44,41,53,.88);--reader-surface:rgba(44,41,53,.98);--glass-edge:rgba(175,199,238,.18);--glass-shadow:0 18px 44px #03091b38,0 3px 12px #03091b1f,inset 0 1px 0 #d4e3ff12;--glow-blue:#6b527340;--glow-violet:#7d63532e}}
html[data-theme=dark]{color-scheme:dark;--bg:#211f28;--fg:#f0ebf4;--muted:#b7adc2;--line:#45404f;--card:#2c2935;--subtle:#393341;--accent:#d0b6f0;--on-accent:#30203f;--danger:#f2a6b4;--glass:rgba(44,41,53,.88);--reader-surface:rgba(44,41,53,.98);--glass-edge:rgba(175,199,238,.18);--glass-shadow:0 18px 44px #03091b38,0 3px 12px #03091b1f,inset 0 1px 0 #d4e3ff12;--glow-blue:#6b527340;--glow-violet:#7d63532e}
@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.top,.card,.toc{background:var(--glass);border-color:var(--glass-edge);-webkit-backdrop-filter:blur(20px) saturate(145%);backdrop-filter:blur(20px) saturate(145%)}.reader{background:var(--reader-surface);border-color:var(--glass-edge)}}
@media(max-width:900px){.layout{grid-template-columns:minmax(0,1fr);gap:16px;margin-top:24px;padding:0 24px}.reader{padding:32px}.toc{grid-row:1;position:static;padding:0 16px}.toc details>summary{min-height:44px}.toc details>summary::after{content:"+";margin-left:auto;font-size:18px;font-weight:400;color:var(--muted)}.toc details[open]>summary::after{content:"−"}.toc nav{max-height:36dvh;margin:4px 0 16px}.title{font-size:30px}}
@media(max-width:600px){.top{width:calc(100% - 24px);min-height:60px;margin-top:12px;padding:10px 16px;border-radius:20px}.brand{font-size:18px}.brand svg{width:28px;height:28px}.layout{margin-top:20px;padding:0 16px}.reader{padding:26px 20px}.title{font-size:27px}.description,.prose{font-size:15px}.meta{margin-bottom:24px;padding-bottom:20px}.prose pre{font-size:12px;padding:44px 14px 16px}.card{width:calc(100% - 32px);margin-top:24px;padding:22px 20px}.share-heading{gap:12px}.share-heading h1{font-size:20px}#unlock{flex-direction:column}#unlock button{width:100%}.share-actions .button{width:100%}footer{padding-top:32px}}
@media(prefers-reduced-transparency:reduce),(prefers-contrast:more){body{background:var(--bg)}.top,.card,.reader,.toc{background:var(--card);border-color:var(--line);-webkit-backdrop-filter:none;backdrop-filter:none}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;
