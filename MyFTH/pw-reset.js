/* =====================================================================
   Forgot password: set a new password with the CODE from the email  (shared by survey.html, dashboard.html, MyFTH)
   Why: company mail scanners (Microsoft Safe Links) may open the one-time link before the person does, which kills it.
   A code that is typed in cannot be used up by a scanner. The old link still works while the email template has one.
   Needs in Supabase > Authentication > Email Templates > Reset Password:  {{ .Token }}  (and no {{ .ConfirmationURL }})
   Load this file BEFORE supabase createClient(): it reads the error of a dead link from the address bar.
   Use:  FTHReset.init({ sb, lang: () => 'th', minLen: 8, onDone: msg => ... });   FTHReset.open(email);
   MyFTH/pw-reset.js is a copy of this file: change both.
   ===================================================================== */
(function () {
  // a dead link comes back as  #error=access_denied&error_code=otp_expired&error_description=...
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const deadLink = !!(hash.get('error_code') || (hash.get('error') && hash.get('error_description')));
  if (deadLink) history.replaceState(null, '', location.pathname + location.search);

  const TEXT = {
    title: { th: 'ตั้งรหัสผ่านใหม่ด้วยรหัสจากอีเมล', en: 'Set a new password with the email code', ja: 'メールのコードで新しいパスワードを設定' },
    hint: { th: 'ถ้าอีเมลมีรหัสตัวเลข ให้กรอกที่นี่ (ใช้รหัสจากอีเมลฉบับล่าสุด) ถ้าอีเมลมีแต่ลิงก์ ให้กดยกเลิกแล้วกดลิงก์ในอีเมล',
            en: 'If the email shows a number code, type it here (use the newest email). If it only has a link, press Cancel and click the link.',
            ja: 'メールに数字のコードがあれば入力してください（最新のメール）。リンクだけの場合はキャンセルしてリンクをクリックしてください。' },
    email: { th: 'อีเมลบริษัท', en: 'Company email', ja: 'メールアドレス' },
    code: { th: 'รหัสจากอีเมล', en: 'Code from the email', ja: 'メールのコード' },
    pw: { th: 'รหัสผ่านใหม่ (อย่างน้อย {0} ตัวอักษร)', en: 'New password (at least {0} characters)', ja: '新しいパスワード（{0}文字以上）' },
    pw2: { th: 'ยืนยันรหัสผ่านใหม่', en: 'Confirm new password', ja: '新しいパスワード（確認）' },
    cancel: { th: 'ยกเลิก', en: 'Cancel', ja: 'キャンセル' },
    save: { th: 'บันทึกรหัสผ่าน', en: 'Save password', ja: '保存' },
    needEmail: { th: 'กรอกอีเมลให้ถูกต้อง', en: 'Enter your email', ja: 'メールアドレスを入力してください' },
    needCode: { th: 'กรอกรหัสตัวเลขจากอีเมล', en: 'Enter the number code from the email', ja: 'メールの数字コードを入力してください' },
    short: { th: 'รหัสผ่านสั้นเกินไป (อย่างน้อย {0} ตัวอักษร)', en: 'Password is too short (at least {0} characters)', ja: 'パスワードが短すぎます（{0}文字以上）' },
    mismatch: { th: 'รหัสผ่านสองช่องไม่ตรงกัน', en: 'The two passwords do not match', ja: 'パスワードが一致しません' },
    badCode: { th: 'รหัสไม่ถูกต้องหรือหมดอายุ ใช้รหัสจากอีเมลฉบับล่าสุด หรือกด “ลืมรหัสผ่าน?” เพื่อขอใหม่',
               en: 'The code is wrong or has expired. Use the newest email, or press “Forgot password?” to get a new one.',
               ja: 'コードが違うか期限切れです。最新のメールを使うか、再度「パスワードを忘れた」を押してください。' },
    saveFail: { th: 'บันทึกรหัสผ่านไม่ได้: ', en: 'Could not save the password: ', ja: 'パスワードを保存できません: ' },
    done: { th: 'ตั้งรหัสผ่านใหม่แล้ว กรุณาเข้าสู่ระบบด้วยรหัสใหม่', en: 'Password changed. Sign in with your new password.', ja: 'パスワードを変更しました。新しいパスワードでログインしてください。' },
    deadTitle: { th: 'ลิงก์ใช้ไม่ได้แล้ว', en: 'This link no longer works', ja: 'このリンクは使えません' },
    deadBody: { th: 'ลิงก์หมดอายุหรือถูกใช้ไปแล้ว (บางครั้งระบบตรวจอีเมลเปิดลิงก์ไปก่อน) กรอกอีเมลแล้วกด “ลืมรหัสผ่าน?” เพื่อขอใหม่',
                en: 'The link has expired or was already used (an email scanner may have opened it first). Enter your email and press “Forgot password?” again.',
                ja: 'リンクが期限切れか使用済みです（メールのセキュリティ確認が先に開く場合があります）。もう一度「パスワードを忘れた」を押してください。' },
    ok: { th: 'ตกลง', en: 'OK', ja: 'OK' },
  };

  let cfg = null, root = null, verified = false;
  const tx = (k, a) => { const l = cfg && cfg.lang ? cfg.lang() : 'th'; return (TEXT[k][l] || TEXT[k].en).replace('{0}', a); };
  const CSS = '.fthr{position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55)}'
    + '.fthr form{background:#fff;color:#1b1b1f;border-radius:8px;padding:20px;width:100%;max-width:400px;max-height:92vh;overflow:auto;font:14px/1.5 "Noto Sans Thai",system-ui,sans-serif;text-align:left}'
    + '.fthr h3{margin:0 0 8px;font-size:17px}.fthr p{margin:0 0 12px}.fthr label{display:block;margin:0 0 10px;font-size:13px;color:#1b1b1f}'
    + '.fthr input{display:block;box-sizing:border-box;width:100%;margin-top:4px;padding:9px 10px;border:1px solid #9a9aa2;border-radius:6px;font-size:16px;background:#fff;color:#1b1b1f}'
    + '.fthr input[readonly]{background:#eee}.fthr .fthr-err{color:#b00020;min-height:18px;margin:0 0 10px;font-size:13px}'
    + '.fthr .fthr-row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}'
    + '.fthr button{padding:9px 16px;border-radius:6px;border:1px solid #9a9aa2;background:#fff;color:#1b1b1f;font:inherit;cursor:pointer}'
    + '.fthr button[type=submit]{background:#ffd200;border-color:#e0b800;font-weight:600}.fthr button:disabled{opacity:.55;cursor:default}';

  function mount(html) {
    close();
    if (!document.getElementById('fthrCss')) { const s = document.createElement('style'); s.id = 'fthrCss'; s.textContent = CSS; document.head.appendChild(s); }
    root = document.createElement('div');
    root.className = 'fthr'; root.setAttribute('data-notr', ''); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
    root.innerHTML = '<form novalidate>' + html + '</form>';
    document.body.appendChild(root);
    return root.querySelector('form');
  }
  function close() { if (root) { root.remove(); root = null; } }

  // signed in only to change the password: never leave that session behind
  async function dropSession() { try { await cfg.sb.auth.signOut({ scope: 'local' }); } catch { /* already signed out */ } verified = false; }

  function open(email) {
    verified = false;
    const min = cfg.minLen || 8;
    const f = mount('<h3>' + tx('title') + '</h3><p>' + tx('hint') + '</p>'
      + '<label>' + tx('email') + '<input name="em" type="email" autocomplete="username"></label>'
      + '<label>' + tx('code') + '<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12"></label>'
      + '<label>' + tx('pw', min) + '<input name="pw" type="password" autocomplete="new-password"></label>'
      + '<label>' + tx('pw2') + '<input name="pw2" type="password" autocomplete="new-password"></label>'
      + '<div class="fthr-err" role="alert"></div>'
      + '<div class="fthr-row"><button type="button" data-x>' + tx('cancel') + '</button><button type="submit">' + tx('save') + '</button></div>');
    const el = f.elements, err = f.querySelector('.fthr-err'), btn = f.querySelector('[type=submit]'), x = f.querySelector('[data-x]');
    el.em.value = email || '';
    (email ? el.code : el.em).focus();
    x.onclick = async () => { x.disabled = true; if (verified) await dropSession(); api.busy = false; close(); };
    f.onsubmit = async ev => {
      ev.preventDefault();
      err.textContent = '';
      const em = el.em.value.trim().toLowerCase(), code = el.code.value.replace(/\s/g, ''), a = el.pw.value;
      if (!verified && !/^\S+@\S+\.\S+$/.test(em)) { err.textContent = tx('needEmail'); return; }
      if (!verified && !/^\d{6,10}$/.test(code)) { err.textContent = tx('needCode'); return; }
      if (a.length < min) { err.textContent = tx('short', min); return; }
      if (a !== el.pw2.value) { err.textContent = tx('mismatch'); return; }
      btn.disabled = x.disabled = true;
      api.busy = true;                       // the pages must not open their own "new password" dialog for the event verifyOtp sends
      try {
        if (!verified) {
          const r = await cfg.sb.auth.verifyOtp({ email: em, token: code, type: 'recovery' });
          if (r.error) { api.busy = false; err.textContent = tx('badCode') + ' (' + r.error.message + ')'; return; }
          verified = true;                   // the code is used up now: a retry only has to save the password
          el.em.readOnly = el.code.readOnly = true;
        }
        const u = await cfg.sb.auth.updateUser({ password: a, data: { must_change_password: false } });
        if (u.error) { err.textContent = tx('saveFail') + u.error.message; return; }
        await dropSession();
        api.busy = false;
        close();
        if (cfg.onDone) cfg.onDone(tx('done'));
      } catch (e) {
        if (!verified) api.busy = false;
        err.textContent = tx('saveFail') + (e.message || e);
      } finally {
        btn.disabled = x.disabled = false;
      }
    };
  }

  function showDeadLink() {
    const f = mount('<h3>' + tx('deadTitle') + '</h3><p>' + tx('deadBody') + '</p><div class="fthr-row"><button type="submit">' + tx('ok') + '</button></div>');
    f.onsubmit = ev => { ev.preventDefault(); close(); };
    f.querySelector('button').focus();
  }

  const api = {
    busy: false,
    init(options) {
      cfg = options;
      // wait a moment so the page has applied the saved language
      if (deadLink) setTimeout(showDeadLink, 300);
    },
    open,
  };
  window.FTHReset = api;
})();
