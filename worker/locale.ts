import { normalizeLocale, type Locale } from '../shared/i18n';
import { escapeHtml } from '../shared/markdown';

export function requestLocale(request: Request): Locale {
  const cookie = /(?:^|;\s*)rcloud-locale=(zh|en)(?:;|$)/.exec(request.headers.get('Cookie') || '');
  // An explicit language header follows the current tab preference, even if another tab changed the cookie.
  const explicit = new URL(request.url).pathname.startsWith('/api/') || request.method !== 'GET';
  return normalizeLocale(
    (explicit ? request.headers.get('Accept-Language') : cookie?.[1]) ||
      cookie?.[1] ||
      request.headers.get('Accept-Language') ||
      'zh',
  );
}

export const publicMessages: Record<string, string> = {
  切换主题: 'Switch theme',
  私人云盘: 'Private drive',
  '登录 RCloud': 'Sign in to RCloud',
  设置账号: 'Set up your account',
  '正在加载验证器设置…': 'Loading authenticator setup…',
  密码: 'Password',
  输入密码: 'Enter your password',
  '至少 12 个字符': 'At least 12 characters',
  确认密码: 'Confirm password',
  再次输入密码: 'Enter your password again',
  验证器验证码: 'Authenticator code',
  '6 位验证码或恢复码': '6-digit code or recovery code',
  '6 位验证码': '6-digit code',
  登录: 'Sign in',
  完成设置: 'Complete setup',
  保存恢复码: 'Save your recovery codes',
  '已保存，进入网盘': 'Saved — open drive',
  显示密码: 'Show password',
  隐藏密码: 'Hide password',
  '请使用管理员提供的一次性设置链接。': 'Open the one-time setup link from your administrator.',
  两次密码不一致: 'The passwords do not match',
  文件分享: 'Shared file',
  '正在验证分享…': 'Checking share…',
  请输入分享密码: 'Enter the share password',
  分享密码: 'Share password',
  输入访问密码: 'Enter access password',
  解锁: 'Unlock',
  下载文件: 'Download file',
  网站分享: 'Shared website',
  访问密码: 'Access password',
  打开网站: 'Open website',
  解锁失败: 'Unable to unlock',
  更新于: 'Updated',
  '下载 Markdown': 'Download Markdown',
  本文目录: 'On this page',
  文章目录: 'Table of contents',
  复制: 'Copy',
  已复制: 'Copied',
  复制失败: 'Copy failed',
};

export const publicText = (value: string, locale: Locale) =>
  locale === 'en' ? publicMessages[value] || value : value;
export const uiText = (value: string, locale: Locale) =>
  `<span data-i18n="${escapeHtml(value)}">${escapeHtml(publicText(value, locale))}</span>`;
export const uiAttr = (
  attribute: 'placeholder' | 'aria-label' | 'title',
  value: string,
  locale: Locale,
) =>
  `${attribute}="${escapeHtml(publicText(value, locale))}" data-i18n-${attribute}="${escapeHtml(value)}"`;

export function publicLocaleScript(locale: Locale) {
  return `(()=>{const dictionary=${JSON.stringify(publicMessages).replaceAll('<', '\\u003c')};let locale=${JSON.stringify(locale)};const t=(text)=>locale==='en'?(dictionary[text]||text):text;function apply(){document.querySelectorAll('[data-locale-zh][data-locale-en]').forEach(el=>el.textContent=el.getAttribute('data-locale-'+locale));document.documentElement.lang=locale==='en'?'en':'zh-CN';document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=t(el.dataset.i18n));for(const attr of ['placeholder','aria-label','title'])document.querySelectorAll('[data-i18n-'+attr+']').forEach(el=>el.setAttribute(attr,t(el.getAttribute('data-i18n-'+attr))));const title=document.querySelector('title[data-i18n-title]');if(title)title.textContent=t(title.dataset.i18nTitle)+' · RCloud';const button=document.getElementById('language');if(button){button.textContent=locale==='en'?'中文':'English';button.setAttribute('aria-label',locale==='en'?'切换为中文':'Switch to English');}document.dispatchEvent(new Event('rcloud:locale'));}window.RCloudI18n={t,get locale(){return locale},set(value){locale=value==='en'?'en':'zh';try{localStorage.setItem('rcloud-locale',locale)}catch{}document.cookie='rcloud-locale='+locale+'; Path=/; Max-Age=31536000; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');apply();}};try{const saved=localStorage.getItem('rcloud-locale');if(saved==='en'||saved==='zh')locale=saved}catch{}document.getElementById('language')?.addEventListener('click',()=>window.RCloudI18n.set(locale==='en'?'zh':'en'));apply();})();`;
}
