const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

export const loginCss = `
.login-layout{width:100%;flex:1;display:grid;place-items:center;padding:52px 24px 28px}
.login-main{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);width:100%;max-width:840px;min-width:0;overflow:hidden;background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow)}
.login-heading{display:flex;flex-direction:column;align-items:flex-start;padding:40px;border-right:1px solid var(--line);background:var(--subtle)}
.login-symbol{display:grid;place-items:center;width:54px;height:54px;margin-bottom:64px;border:1px solid var(--line);border-radius:15px;background:var(--card);color:var(--accent)}
.login-symbol svg{width:26px;height:26px}
.login-label{margin:0 0 12px;color:var(--muted);font-size:11px;font-weight:550;letter-spacing:1px}
.login-main h1{margin:0;font-size:36px;font-weight:650;letter-spacing:-1.2px;line-height:1.35}
.login-content{min-width:0;padding:40px}
#auth{display:flex;flex-direction:column;gap:24px}
.field-label{display:block;margin-bottom:9px;font-size:12px;font-weight:600}
.field-wrap{position:relative;display:flex;align-items:center}
.field-wrap input{height:48px;padding:11px 13px;background:var(--card)}
.field-wrap input#password{padding-right:46px}
.password-toggle{position:absolute;right:4px;display:grid;place-items:center;width:38px;min-height:38px;padding:9px;border:0;background:transparent;color:var(--muted)}
.password-toggle svg{width:18px;height:18px}
#submit{width:100%;min-height:48px;margin-top:8px;border-color:var(--accent);background:var(--accent);color:var(--on-accent);box-shadow:0 3px 7px #183b2410;font-size:14px}
#submit:hover{filter:brightness(.96)}
#submit svg{width:17px;height:17px}
#error:not(:empty){margin:20px 0 0;padding:10px 12px;border-left:2px solid var(--danger);background:var(--subtle);color:var(--danger);font-size:13px;overflow-wrap:anywhere}
#error:empty,#loading:empty,#secret:empty{display:none}
#loading{margin:0 0 20px;color:var(--muted);font-size:13px}
#qr:not(:empty){max-width:190px;margin:0 auto 18px;padding:12px;background:#fff;border:1px solid var(--line);border-radius:10px}
#qr svg{display:block;width:100%;height:auto}
#secret:not(:empty){display:block;margin-bottom:24px;padding:11px 13px;border:1px solid var(--line);border-radius:9px;background:var(--subtle);font:12px/1.85 "SFMono-Regular",Consolas,monospace;word-break:break-all;text-align:center}
#recovery h2{margin:0 0 16px;font-size:22px;letter-spacing:-.4px}
#recovery pre{margin:0 0 22px;padding:18px;border:1px solid var(--line);border-radius:10px;background:var(--subtle);font:13px/2 "SFMono-Regular",Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
#recovery .button{width:100%}
@media(max-width:760px){.login-main{max-width:440px;grid-template-columns:minmax(0,1fr)}.login-heading{display:grid;grid-template-columns:48px minmax(0,1fr);gap:5px 16px;padding:28px;border-right:0;border-bottom:1px solid var(--line)}.login-symbol{grid-row:1/3;width:48px;height:48px;margin:0}.login-label{margin:0;align-self:end;font-size:10px}.login-main h1{font-size:27px;letter-spacing:-.7px}.login-content{padding:28px}}
@media(max-width:600px){.login-layout{padding:28px max(16px,env(safe-area-inset-right)) 16px max(16px,env(safe-area-inset-left))}.login-main{border-radius:16px}.login-heading{padding:24px}.login-content{padding:28px 24px}}
@media(max-width:360px){.login-heading{padding:22px 20px;gap:5px 12px}.login-content{padding:24px 20px}.login-main h1{font-size:25px}}
@media(max-height:700px){.login-layout{padding-top:24px;padding-bottom:12px}.login-content{padding-top:26px;padding-bottom:26px}.login-symbol{margin-bottom:32px}#auth{gap:20px}footer{padding:22px 24px 16px}}
@media(max-height:700px) and (max-width:760px){.login-symbol{margin-bottom:0}}
@media(prefers-contrast:more){.login-main{box-shadow:none}}
`;

export function loginBody(ready: boolean) {
  const field = (id: string, label: string, placeholder: string, type = 'text', extra = '') =>
    `<div class="form-field"><label class="field-label" for="${id}">${label}</label><div class="field-wrap"><input id="${id}" type="${type}" placeholder="${placeholder}" required ${extra}>${id === 'password' ? '<button type="button" id="password-toggle" class="password-toggle" aria-label="显示密码">' + icon('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>') + '</button>' : ''}</div></div>`;
  return `<main class="login-layout"><section class="login-main" aria-labelledby="login-title"><div class="login-heading"><span class="login-symbol" aria-hidden="true">${icon('<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>')}</span><p class="login-label">私人云盘</p><h1 id="login-title">${ready ? '登录 RCloud' : '设置账号'}</h1></div><div class="login-content"><p id="loading">${ready ? '' : '正在加载验证器设置…'}</p><div id="qr"></div><code id="secret"></code><form id="auth" ${ready ? '' : 'hidden'}>${field('password', '密码', ready ? '输入密码' : '至少 12 个字符', 'password', `autocomplete="${ready ? 'current-password' : 'new-password'}" minlength="${ready ? 1 : 12}" maxlength="128"`)}${ready ? '' : field('confirm', '确认密码', '再次输入密码', 'password', 'autocomplete="new-password" minlength="12" maxlength="128"')}${field('code', '验证器验证码', ready ? '6 位验证码或恢复码' : '6 位验证码', 'text', 'autocomplete="one-time-code" maxlength="16" autocapitalize="none" spellcheck="false"')}<button id="submit"><span>${ready ? '登录' : '完成设置'}</span>${icon('<path d="M5 12h14m-5-5 5 5-5 5"/>')}</button></form><p id="error" role="alert" aria-live="polite"></p><section id="recovery" hidden><h2>保存恢复码</h2><pre id="codes"></pre><a class="button" href="/drive/">已保存，进入网盘</a></section></div></section></main>`;
}

export const loginUiScript = String.raw`document.getElementById('password-toggle')?.addEventListener('click',()=>{const p=document.getElementById('password');const b=document.getElementById('password-toggle');p.type=p.type==='password'?'text':'password';b.setAttribute('aria-label',p.type==='password'?'显示密码':'隐藏密码');});document.getElementById('theme')?.addEventListener('click',()=>{const dark=(document.documentElement.dataset.theme|| (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'))==='dark';document.documentElement.dataset.theme=dark?'light':'dark';try{localStorage.setItem('theme',document.documentElement.dataset.theme)}catch{}});`;
