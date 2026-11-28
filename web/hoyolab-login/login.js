/* Credentials are submitted only to this origin and never stored in browser storage. */
(async () => {
  'use strict';
  const base = '/hoyolab-login', token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  let text = {}, state, challenge, widget, busy = false, finished = false;
  const byId = id => document.getElementById(id);
  const status = (value, failed = false) => { byId('status').textContent = value; byId('status').classList.toggle('error', failed); };
  const setBusy = value => { busy = value; document.querySelectorAll('button,input').forEach(element => { element.disabled = value; }); };
  async function api(action, body = {}) {
    const response = await fetch(`${base}/${action}`, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || text.network); error.expired = response.status === 401 || response.status === 409 && !busy; throw error; }
    return result;
  }
  function display(result) {
    state = result.state;
    if (result.message) status(result.message);
    for (const id of ['password-form', 'email-form', 'captcha', 'retry', 'cancel']) byId(id).hidden = true;
    if (state === 'complete' || state === 'cancelled') { finished = true; widget?.destroy(); return; }
    byId('cancel').hidden = false;
    if (state === 'password') byId('password-form').hidden = false;
    if (state === 'email') byId('email-form').hidden = false;
    if (state === 'saving') byId('retry').hidden = false;
    if (state === 'captcha') { challenge = result.challenge; byId('captcha').hidden = false; }
  }
  async function run(action, body) {
    if (busy || finished) return;
    setBusy(true);
    try { display(await api(action, body)); }
    catch (error) {
      status(error.message || text.network, true);
      if (error.expired) display({state:'cancelled'});
      else {
        try { const current = await api('status'); if (current.state !== state) display(current); }
        catch { /* Retain the visible form for a bounded retry. */ }
      }
    } finally { setBusy(false); }
  }
  const loaded = new Map();
  function loadScript(url) {
    if (!loaded.has(url)) loaded.set(url, new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = url; script.referrerPolicy = 'no-referrer';
      script.onload = resolve; script.onerror = () => { loaded.delete(url); reject(new Error(text.network)); };
      document.head.append(script);
    }));
    return loaded.get(url);
  }
  byId('password-form').addEventListener('submit', event => {
    event.preventDefault(); const fields = new FormData(event.target), password = fields.get('password'), account = fields.get('account');
    event.target.elements.password.value = ''; void run('password', {account,password});
  });
  byId('email-form').addEventListener('submit', event => {
    event.preventDefault(); const code = new FormData(event.target).get('code'); event.target.elements.code.value = ''; void run('email', {code});
  });
  byId('resend').addEventListener('click', () => { void run('resend'); });
  byId('retry').addEventListener('click', () => { void run('password'); });
  byId('cancel').addEventListener('click', () => { void run('cancel'); });
  byId('captcha').addEventListener('click', async () => {
    if (busy || !challenge) return;
    setBusy(true);
    try {
      widget?.destroy();
      const v4 = challenge.version === 4;
      await loadScript(v4 ? 'https://static.geetest.com/v4/gt4.js' : 'https://static.geetest.com/static/tools/gt.js');
      await new Promise((resolve, reject) => {
        const init = v4 ? window.initGeetest4 : window.initGeetest;
        init(v4 ? {captchaId:challenge.gt,product:'bind',language:'zho',riskType:challenge.riskType,
          apiServers:['gcaptcha4.captchami.com']} : {gt:challenge.gt,challenge:challenge.challenge,new_captcha:true,offline:false,
          product:'bind',https:true,lang:'zh-cn',api_server:'api.geetest.com'}, object => {
          widget = object;
          object.onReady(() => { setBusy(false); object.verify(); resolve(); });
          object.onSuccess(() => { const result = object.getValidate(); if (result) void run('captcha', {result}); });
          object.onError(() => { status(text.network, true); setBusy(false); reject(new Error(text.network)); });
        });
      });
    } catch (error) { status(error.message || text.network, true); }
    finally { setBusy(false); }
  });
  try {
    const response = await fetch(`${base}/messages`, {cache:'no-store'}); text = await response.json();
    document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = text[element.dataset.i18n] || ''; });
    document.title = `${text.title} · Lotus-Yunzai`;
    if (!token) { status(text.expired, true); return; }
    display(await api('status'));
  } catch (error) { status(error.message || text.network, true); }
})();
