export const publicCss = `:root{color-scheme:light dark;--bg:#f5f7f6;--fg:#23352d;--muted:#738078;--line:#e4eae6;--card:#fff;--accent:#347456}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.8 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.top{height:68px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;padding:0 6vw;font-size:14px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:2px}
.brand svg{width:30px;height:30px}
.layout{max-width:1180px;margin:54px auto;display:grid;grid-template-columns:minmax(0,820px) 200px;gap:48px;padding:0 28px}
.reader{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:42px 46px}
.description:empty{display:none}
.reader{min-width:0}
.eyebrow{font-size:12px;color:var(--muted);letter-spacing:2px}
.title{font-size:clamp(28px,3vw,38px);line-height:1.35;letter-spacing:-1px;margin:12px 0}
.description{color:var(--muted)}
.meta{color:var(--muted);font-size:13px;border-bottom:1px solid var(--line);padding:14px 0 28px}
.prose{overflow-wrap:anywhere}
.prose h1,.prose h2,.prose h3,.prose h4{line-height:1.4;scroll-margin-top:24px}
.prose h2{margin-top:2em;border-bottom:1px solid var(--line);padding-bottom:.4em}
.prose a{text-decoration:underline}
.prose img{max-width:100%;border-radius:8px}
.prose pre{position:relative;overflow:auto;padding:24px 20px;background:#202622;color:#e6eee8;border-radius:10px;font-size:13px;line-height:1.7}
.prose code{font-family:Consolas,monospace}
.prose :not(pre)>code{padding:2px 5px;background:var(--line);border-radius:4px;font-size:.88em}
.prose table{display:block;overflow:auto;border-collapse:collapse}
.prose th,.prose td{border:1px solid var(--line);padding:8px 16px}
.prose blockquote{margin-left:0;padding:6px 20px;border-left:3px solid var(--accent);background:var(--card);color:var(--muted)}
.prose hr{border:0;border-top:1px solid var(--line);margin:32px 0}
.toc{position:sticky;top:30px;align-self:start;font-size:13px;border-left:1px solid var(--line);padding-left:20px}
.toc details>summary{cursor:pointer;font-weight:600;min-height:44px;list-style:none}
.toc nav{max-height:65vh;overflow:auto}
.toc a{display:block;color:var(--muted);line-height:1.5;margin:12px 0}
.hljs-keyword,.hljs-selector-tag{color:#c8a5dc}
.hljs-string,.hljs-attr{color:#b2d7a7}
.hljs-number,.hljs-literal{color:#e5bf8b}
.hljs-comment{color:#91a296}
.card{max-width:700px;margin:64px auto;padding:32px;background:var(--card);border:1px solid var(--line);border-radius:16px}
.card iframe,.card img,.card video{width:100%;max-height:60vh;border:0;object-fit:contain}
.card audio{width:100%}
.card pre{white-space:pre-wrap;max-height:60vh;overflow:auto}
button,.button{cursor:pointer;min-height:44px;padding:9px 16px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);font:inherit;font-size:14px}
.button{display:inline-block;background:var(--accent);color:#fff;border:0}
input{padding:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;font:inherit}
.copy{position:absolute;top:8px;right:8px;background:#303c34;color:#fff;font-size:11px;padding:3px 8px}
.error{color:#b24a45}
footer{text-align:center;margin:56px 0;font-size:12px;color:var(--muted)}
@media(prefers-color-scheme:dark){:root{--bg:#151a17;--fg:#e6ece8;--muted:#9aa79f;--line:#303b34;--card:#1d2520;--accent:#99c4a7}
}
html[data-theme=dark]{--bg:#151a17;--fg:#e6ece8;--muted:#9aa79f;--line:#303b34;--card:#1d2520;--accent:#99c4a7}
html[data-theme=light]{--bg:#f5f7f6;--fg:#23352d;--muted:#738078;--line:#e4eae6;--card:#fff;--accent:#347456}
@media(max-width:900px){.layout{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;margin:22px auto;padding:0 16px}
.reader{padding:26px 22px;border-radius:16px}
.toc{grid-row:1;position:static;margin:0;padding:0 16px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.toc details>summary{display:flex;align-items:center}
.toc details>summary::after{content:"⌄";margin-left:auto}
.toc nav{max-height:35vh}
.title{font-size:28px}
.card{margin:24px 16px;padding:24px}
.top{padding:0 20px}
.prose pre{padding:22px 14px;font-size:12px}
input{font-size:16px}
}
/* Keep reading surfaces solid; only navigation floats above the page. */
body{background:radial-gradient(ellipse at 10% 0%,color-mix(in srgb,var(--accent) 9%,transparent),transparent 60%),var(--bg);background-attachment:fixed;min-height:100dvh}
.top{position:relative;margin:14px auto 0;width:calc(100% - 40px);max-width:1180px;height:64px;padding:0 24px;border:1px solid color-mix(in srgb,var(--card) 80%,var(--line));border-radius:23px;background:var(--card);box-shadow:0 8px 30px #173b2410,inset 0 1px 0 #ffffff18}
.reader,.card{box-shadow:0 12px 40px #173b2409;border-radius:24px}
#theme{border-radius:50px}
@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.top{background:color-mix(in srgb,var(--card) 88%,transparent);-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px)}}
@media(max-width:720px){.top{margin-top:10px;width:calc(100% - 24px);height:62px;padding:0 16px;border-radius:21px}}
@media(prefers-reduced-transparency:reduce),(prefers-contrast:more){.top{background:var(--card);border-color:var(--line);-webkit-backdrop-filter:none;backdrop-filter:none}}
`;
