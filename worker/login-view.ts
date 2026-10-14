const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const loginCss = `
.login-layout{width:100%;flex:1;display:grid;place-items:center;padding:48px 24px 24px}
.login-main{width:100%;max-width:420px;min-width:0;padding:36px;background:var(--card);border:1px solid var(--line);border-radius:24px;box-shadow:var(--glass-shadow)}
.login-heading{margin-bottom:30px}
.login-label{margin:0 0 8px;color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.8px}
.login-main h1{margin:0;font-size:28px;font-weight:650;letter-spacing:-.8px;line-height:1.4}
#auth{display:flex;flex-direction:column;gap:22px}
.field-label{display:block;margin-bottom:8px;font-size:13px;font-weight:500}
.field-wrap{position:relative;display:flex;align-items:center}
.field-wrap input{height:46px;padding:10px 12px;background:var(--card);box-shadow:inset 0 1px 2px #213c6805}
.field-wrap input#password{padding-right:46px}
.password-toggle{position:absolute;right:4px;display:grid;place-items:center;width:38px;min-height:38px;padding:9px;border:0;background:transparent;color:var(--muted)}
.password-toggle svg{width:18px;height:18px}
#submit{width:100%;min-height:46px;margin-top:4px;border-color:var(--accent);background:var(--accent);color:var(--on-accent);box-shadow:0 5px 14px #3559e01f,inset 0 1px 0 #ffffff24;font-size:14px}
#submit:hover{filter:brightness(.96)}
#submit svg{width:17px;height:17px}
#error:not(:empty){margin:20px 0 0;padding:10px 12px;border-left:2px solid var(--danger);background:var(--subtle);color:var(--danger);font-size:13px;overflow-wrap:anywhere}
#error:empty,#loading:empty,#secret:empty{display:none}
#loading{margin:0 0 20px;color:var(--muted);font-size:13px}
#qr:not(:empty){max-width:190px;margin:0 auto 16px;padding:12px;background:#fff;border:1px solid var(--line);border-radius:8px}
#qr svg{display:block;width:100%;height:auto}
#secret:not(:empty){display:block;margin-bottom:24px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--subtle);font:12px/1.8 "Cascadia Code",Consolas,monospace;word-break:break-all;text-align:center}
#recovery h2{margin:0 0 16px;font-size:22px;letter-spacing:-.4px}
#recovery pre{margin:0 0 22px;padding:16px;border:1px solid var(--line);border-radius:8px;background:var(--subtle);font:13px/2 "Cascadia Code",Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
#recovery .button{width:100%}
@supports ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.login-main{background:var(--glass);border-color:var(--glass-edge);-webkit-backdrop-filter:blur(20px) saturate(145%);backdrop-filter:blur(20px) saturate(145%)}}
@media(max-width:600px){.login-layout{padding:32px 20px 16px}.login-main{padding:28px 24px}.login-main h1{font-size:26px}.login-heading{margin-bottom:28px}}
@media(max-width:360px){.login-layout{padding-right:16px;padding-left:16px}.login-main{padding:26px 20px}}
@media(max-height:700px){.login-layout{padding-top:20px;padding-bottom:12px}.login-main{padding-top:24px;padding-bottom:24px}.login-heading{margin-bottom:24px}#auth{gap:18px}footer{padding:22px 24px 16px}}
@media(prefers-reduced-transparency:reduce),(prefers-contrast:more){.login-main{background:var(--card);border-color:var(--line);-webkit-backdrop-filter:none;backdrop-filter:none}}
`;

export function loginBody(ready: boolean) {
  const field = (id: string, label: string, placeholder: string, type = 'text', extra = '') =>
    `<div class="form-field"><label class="field-label" for="${id}">${label}</label><div class="field-wrap"><input id="${id}" type="${type}" placeholder="${placeholder}" required ${extra}>${id === 'password' ? '<button type="button" id="password-toggle" class="password-toggle" aria-label="显示密码">' + icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>') + '</button>' : ''}</div></div>`;
  return `<main class="login-layout"><section class="login-main" aria-labelledby="login-title"><div class="login-heading"><p class="login-label">私人云盘</p><h1 id="login-title">${ready ? '登录 RCloud' : '设置账号'}</h1></div><p id="loading">${ready ? '' : '正在加载验证器设置…'}</p><div id="qr"></div><code id="secret"></code><form id="auth" ${ready ? '' : 'hidden'}>${field('password', '密码', ready ? '输入密码' : '至少 12 个字符', 'password', `autocomplete="${ready ? 'current-password' : 'new-password'}" minlength="${ready ? 1 : 12}" maxlength="128"`)}${ready ? '' : field('confirm', '确认密码', '再次输入密码', 'password', 'autocomplete="new-password" minlength="12" maxlength="128"')}${field('code', '验证器验证码', ready ? '6 位验证码或恢复码' : '6 位验证码', 'text', 'autocomplete="one-time-code" maxlength="16" autocapitalize="none" spellcheck="false"')}<button id="submit"><span>${ready ? '登录' : '完成设置'}</span>${icon('<path d="M5 12h14m-5-5 5 5-5 5"/>')}</button></form><p id="error" role="alert" aria-live="polite"></p><section id="recovery" hidden><h2>保存恢复码</h2><pre id="codes"></pre><a class="button" href="/drive/">已保存，进入网盘</a></section></section></main>`;
}

export const loginUiScript = String.raw`document.getElementById('password-toggle')?.addEventListener('click',()=>{const p=document.getElementById('password');const b=document.getElementById('password-toggle');p.type=p.type==='password'?'text':'password';b.setAttribute('aria-label',p.type==='password'?'显示密码':'隐藏密码');});document.getElementById('theme')?.addEventListener('click',()=>{const dark=(document.documentElement.dataset.theme|| (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'))==='dark';document.documentElement.dataset.theme=dark?'light':'dark';try{localStorage.setItem('theme',document.documentElement.dataset.theme)}catch{}});`;
