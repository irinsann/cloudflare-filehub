import { escapeHtml } from '../shared/markdown';
import { brandMark } from '../shared/brand';
import { publicCss } from './public-styles';
export const readerScript = `const toc=document.querySelector('.toc details');if(toc){const mq=matchMedia('(min-width:901px)');const sync=()=>toc.open=mq.matches;sync();mq.addEventListener('change',sync);}document.querySelectorAll('pre').forEach(pre=>{const b=document.createElement('button');b.className='copy';b.textContent='复制';b.onclick=async()=>{try{await navigator.clipboard.writeText(pre.querySelector('code')?.textContent||'');b.textContent='已复制'}catch{b.textContent='复制失败'}};pre.append(b)});document.getElementById('theme')?.addEventListener('click',()=>{document.documentElement.dataset.theme=(document.documentElement.dataset.theme|| (matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'))==='dark'?'light':'dark';try{localStorage.setItem('theme',document.documentElement.dataset.theme)}catch{}});`;
export function htmlPage(
  title: string,
  body: string,
  script = readerScript,
  meta = '',
  pageCss = '',
) {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return {
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><title>${escapeHtml(title)} · RCloud</title>${meta}<script nonce="${nonce}">try{const t=localStorage.getItem("theme");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch{}</script><style nonce="${nonce}">${publicCss}${pageCss}</style></head><body><header class="top"><span class="brand">${brandMark}<span>RCloud</span></span><button id="theme" type="button" aria-label="切换主题" title="切换主题"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14a9 9 0 0 1-10.5-10.5A9 9 0 1 0 20.5 14Z"/></svg></button></header>${body}<footer>RCloud</footer><script nonce="${nonce}">${script}</script></body></html>`,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' https:; media-src 'self'; frame-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  };
}
