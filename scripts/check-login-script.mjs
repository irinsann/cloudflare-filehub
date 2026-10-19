import vm from 'node:vm';
const r = await fetch(process.argv[2] || 'https://cloud.example.com/login');
if (!r.ok) throw Error('Login page status ' + r.status);
const html = await r.text();
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw Error('Missing login script');
for (const s of scripts) new vm.Script(s[1]);
console.log('登录页面脚本语法检查通过。');
