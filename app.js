'use strict';
(() => {
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const KEYS = { url: 'keyhub_api_url_v1', device: 'keyhub_device_id_v1', refresh: 'keyhub_remember_refresh_v1' };
  let apiUrl = localStorage.getItem(KEYS.url) || '';
  let deviceId = localStorage.getItem(KEYS.device) || '';
  // Access tokens and passwords stay in memory. Only an opt-in refresh token
  // is persisted so a returning user can restore a session.
  let access = null, refresh = localStorage.getItem(KEYS.refresh) || null;
  let rememberLogin = Boolean(refresh), renewal = null;
  let me = null, tab = 'home';
  let licenseQuery = '', licenseStatus = 'all';
  let licenses = [], apiKeys = [], devices = [], viewedKey = '', revealed = null;
  let deviceEvents = [], showDeviceHistory = false, editingDeviceId = '';
  let activationResult = null;
  let busy = false, messageTimeout;
  if (!deviceId) {
    deviceId = globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID() : 'browser-' + Array.from(globalThis.crypto.getRandomValues(new Uint8Array(20)), b => b.toString(16).padStart(2,'0')).join('');
    localStorage.setItem(KEYS.device, deviceId);
  }
  const esc = x => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = ts => ts ? new Date(ts * 1000).toLocaleString('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
  function persistSession() {
    if (rememberLogin && refresh) localStorage.setItem(KEYS.refresh, refresh);
    else localStorage.removeItem(KEYS.refresh);
  }
  function clearSession() {
    access = null; refresh = null; me = null; rememberLogin = false;
    licenses = []; apiKeys = []; devices = []; revealed = null;
    localStorage.removeItem(KEYS.refresh);
  }
  async function renewSession() {
    if (!refresh) throw Error('Chưa có phiên đăng nhập để khôi phục.');
    if (renewal) return renewal;
    const token = refresh;
    renewal = (async () => {
      const next = await request('/auth/refresh', 'POST', {refresh_token:token}, false);
      access = next.access_token;
      refresh = next.refresh_token;
      persistSession(); // Refresh tokens are single-use, always store the rotated value.
    })();
    try { await renewal; } finally { renewal = null; }
  }
  async function restoreSession() {
    try {
      await renewSession();
      me = await request('/me');
      await loadData();
      tab = 'home'; render();
    } catch (err) {
      if (err.status === 401 || err.status === 403) clearSession();
      tab = 'signin'; render();
      notify(err.status === 401 || err.status === 403
        ? 'Phiên đã hết hạn, hãy đăng nhập lại.'
        : 'Chưa thể khôi phục đăng nhập. Hãy thử lại khi mạng ổn định.', true);
    }
  }
  function notify(message,error=false) {
    toastEl.textContent = message;
    toastEl.className = 'visible'+(error?' error':'');
    clearTimeout(messageTimeout);
    messageTimeout = setTimeout(()=>toastEl.className='',4800);
  }
  function normalizedUrl(str) {
    const u = new URL(str.trim());
    if (u.protocol !== 'https:' && !(u.hostname === 'localhost' || u.hostname === '127.0.0.1')) throw Error('API bắt buộc dùng HTTPS.');
    if (u.username || u.password || u.search || u.hash) throw Error('Địa chỉ API không hợp lệ.');
    return u.origin + (u.pathname.replace(/\/+$/,'').endsWith('/api/v1') ? u.pathname.replace(/\/+$/,'') : (u.pathname.replace(/\/+$/,'') || '') + '/api/v1');
  }
  async function request(path,method='GET',data=null,retry=true) {
    if (!apiUrl) throw Error('Bạn chưa cấu hình máy chủ API.');
    const headers = {'Accept':'application/json'};
    if (data != null) headers['Content-Type']='application/json';
    if (access && !['/health','/auth/refresh','/auth/login','/auth/register'].includes(path)) headers['Authorization']='Bearer ' + access;
    const tokenUsed = headers['Authorization'];
    let response;
    try { response = await fetch(apiUrl+path,{method,headers,body:data == null?undefined:JSON.stringify(data),cache:'no-store'}); }
    catch { throw Error('Không kết nối được máy chủ. Kiểm tra URL API và CORS trên Render.'); }
    if (response.status===401 && retry && refresh && tokenUsed && path!=='/auth/refresh') {
      try {
        // Another request may already have rotated a single-use refresh token.
        if (tokenUsed === 'Bearer ' + access) await renewSession();
        return request(path,method,data,false);
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          clearSession(); tab='signin'; render();
          throw Error('Phiên đăng nhập hết hạn. Hãy đăng nhập lại.');
        }
        throw err;
      }
    }
    let result;
    try {result=await response.json();} catch {result={};}
    if (!response.ok) {
      const err=Array.isArray(result.detail) ? result.detail.map(x=>x.msg).join('; ') : result.detail;
      const failure = Error(typeof err==='string'?err:('Yêu cầu thất bại (HTTP '+response.status+').'));
      failure.status = response.status;
      throw failure;
    }
    return result;
  }
  const btn=(label, action, cls='alt', attrs='')=>`<button type="button" class="btn ${cls}" data-action="${action}" ${attrs}>${label}</button>`;
  function header(subtitle) {
    return `<header class="header"><div class="head-row"><div class="brand"><span class="brand-icon">⚿</span><span>KeyHub</span></div><button type="button" class="icon-button" data-action="settings">⚙ Cài đặt</button></div><h1>${esc(subtitle)}</h1><p>${me ? esc(me.email)+(me.is_admin?' · Quản trị viên':' · Người dùng') : 'Hệ thống quản lý giấy phép riêng'}</p></header>`;
  }
  function authPanel() {
    return `${header('Chào mừng quay lại')}<main class="content auth"><section class="panel"><div class="auth-intro"><div class="auth-mark">🔑</div><h2>Đăng nhập KeyHub</h2><p class="muted">Quản lý License an toàn và thuận tiện</p></div><form class="stack" data-form="login"><div class="field"><label>Email</label><input name="email" type="email" autocomplete="username" placeholder="email@example.com" required></div><div class="field"><label>Mật khẩu</label><input name="password" type="password" autocomplete="current-password" required></div><label class="remember"><input type="checkbox" name="remember" checked><span>Ghi nhớ đăng nhập trên thiết bị này<small>Không bật trên thiết bị dùng chung. Phiên sẽ được tự khôi phục khi mở lại web.</small></span></label><button class="btn full" type="submit">Đăng nhập</button></form>${refresh?'<div class="actions">'+btn('Thử khôi phục phiên','retry-session','alt')+'</div>':''}<div class="actions">${btn('Tạo tài khoản mới','register','alt')}${btn('Kết nối API','settings','alt')}</div></section><div class="notice">Không lưu mật khẩu. Khi chọn ghi nhớ, trình duyệt lưu mã làm mới phiên. Chỉ nên dùng trên iPhone cá nhân, và nhấn Đăng xuất khi không sử dụng.</div></main>`;
  }
  function registerPanel() {
    return `${header('Tạo tài khoản')}<main class="content auth"><section class="panel"><h2>Đăng ký người dùng</h2><form class="stack" data-form="register"><div class="field"><label>Email</label><input name="email" type="email" autocomplete="email" required></div><div class="field"><label>Mật khẩu (ít nhất 12 ký tự)</label><input name="password" type="password" autocomplete="new-password" minlength="12" required></div><button class="btn full" type="submit">Đăng ký</button></form><div class="actions">${btn('Quay lại đăng nhập','signin')}</div></section></main>`;
  }
  function settingsPanel() {
    return `${header('Kết nối máy chủ')}<main class="content auth"><section class="panel"><h2>Cấu hình Key Server</h2><p class="muted">Dán URL HTTPS backend Render, ví dụ <strong>https://keyhub-api.onrender.com</strong></p><form class="stack" data-form="settings"><div class="field"><label>URL máy chủ API</label><input name="api_url" inputmode="url" type="url" value="${esc(apiUrl)}" placeholder="https://keyhub-api.onrender.com" required></div><button class="btn full" type="submit">Lưu và kiểm tra kết nối</button></form><div class="notice" style="margin-top:16px">Máy chủ phải bật CORS cho đúng tên miền Cloudflare Pages của website này. Không nhập API Key bí mật hoặc mật khẩu vào ô URL.</div><div class="actions">${btn('Quay lại','back')}</div></section></main>`;
  }
  function menu() {
    const pages=[['home','⌂','Tổng quan'],['keys','⚿','License'],['api','⌘','API Key'],['account','◎','Tài khoản']];
    return `<nav class="tabbar" aria-label="Điều hướng">${pages.map(([id,ic,title])=>`<button class="nav-btn ${tab===id?'selected':''}" data-action="tab" data-tab="${id}" ${tab===id?'aria-current="page"':''}><b>${ic}</b>${title}</button>`).join('')}</nav>`;
  }
  function stats() {
    const active=licenses.filter(x=>x.is_active).length, expiring=licenses.filter(x=>x.is_active&&(x.expires_at-Date.now()/1000)<7*86400).length;
    return `<div class="stats"><div class="stat"><span>License tải về</span><strong>${licenses.length}</strong></div><div class="stat"><span>Đang hoạt động</span><strong>${active}</strong></div><div class="stat"><span>Sắp hết hạn (7 ngày)</span><strong>${expiring}</strong></div><div class="stat"><span>API Key của tôi</span><strong>${apiKeys.length}</strong></div></div>`;
  }
  function homePanel() {
    return `${stats()}<section class="panel"><h2>Thao tác nhanh</h2><p class="muted">Tạo và quản lý License ngay trên điện thoại.</p><div class="actions">${btn('Danh sách License','nav-keys')}${btn('Quản lý API Key','nav-api')}${me.is_admin?btn('Cấp License mới','nav-issue','') : btn('Kích hoạt License','nav-activate','')}</div></section><section class="panel"><h2>Trạng thái máy chủ</h2><p class="muted">${esc(apiUrl)}</p><div class="actions">${btn('Kiểm tra kết nối','ping')}</div></section><div class="notice">Dữ liệu lấy trực tiếp từ Key Server. Telegram Bot KeyHub đã được tích hợp riêng. Hiện chưa có sao lưu tự động hoặc thanh toán.</div>`;
  }
  function keyRecord(item) {
    const attrs=`data-id="${esc(item.id)}"`;
    return `<div class="record"><div class="record-header"><div><div class="record-title">${esc(item.prefix)}…</div><div class="record-meta">Chủ sở hữu: ${esc(item.owner_email)}<br>Hạn: ${fmt(item.expires_at)}<br>Thiết bị: ${item.device_count} / ${item.device_limit}${item.note?'<br>Ghi chú: '+esc(item.note):''}</div></div><span class="pill ${item.is_active?'':'off'}">${item.is_active?'Hiệu lực':'Hết hạn/Thu hồi'}</span></div><div class="actions">${btn('Thiết bị','devices','small alt',attrs)}${me.is_admin && item.is_active?btn('Thu hồi','revoke','small danger',attrs):''}${me.is_admin && !item.is_active?btn('Xóa vĩnh viễn','delete-license','small danger',attrs):''}</div></div>`;
  }
  function filteredLicenses() {
    const term = licenseQuery.trim().toLocaleLowerCase('vi-VN');
    return licenses.filter(item => {
      if (licenseStatus === 'active' && !item.is_active) return false;
      if (licenseStatus === 'inactive' && item.is_active) return false;
      if (!term) return true;
      return [item.prefix, item.owner_email, item.note].some(value =>
        String(value || '').toLocaleLowerCase('vi-VN').includes(term));
    });
  }
  function licenseCards() {
    const shown = filteredLicenses();
    return shown.length ? shown.map(keyRecord).join('')
      : '<div class="empty">Không tìm thấy License phù hợp với bộ lọc.</div>';
  }
  function licensesPanel() {
    return `<section class="panel"><h2>License</h2><div class="actions">${me.is_admin?btn('Cấp License','nav-issue',''):btn('Kích hoạt','nav-activate','')}${btn('Tải lại','refresh','alt')}</div><div class="license-filters"><label class="field">Tìm License<input data-filter="license-query" type="search" autocomplete="off" value="${esc(licenseQuery)}" placeholder="Mã, email hoặc ghi chú…"></label><label class="field">Trạng thái<select data-filter="license-status"><option value="all" ${licenseStatus==='all'?'selected':''}>Tất cả</option><option value="active" ${licenseStatus==='active'?'selected':''}>Còn hiệu lực</option><option value="inactive" ${licenseStatus==='inactive'?'selected':''}>Hết hạn / đã thu hồi</option></select></label></div><div class="result-count" id="license-count"></div><div id="license-results">${licenseCards()}</div>${me.is_admin?'<div class="actions">'+btn('Xóa tất cả Key hết hạn / đã thu hồi','delete-inactive-licenses','danger')+'</div><p class="hint">Chỉ xóa License đã hết hạn hoặc bị thu hồi. Xóa vĩnh viễn cả thiết bị và lịch sử liên quan; không thể hoàn tác. Tối đa 500 License/lần.</p>':''}</section>`;
  }
  function updateLicenseFilters() {
    const box = document.getElementById('license-results');
    if (!box) return;
    box.innerHTML = licenseCards();
    const count = document.getElementById('license-count');
    if (count) count.textContent = 'Hiển thị ' + filteredLicenses().length + ' / ' + licenses.length + ' License';
  }
  function issuePanel() {
    return `<section class="panel"><h2>Cấp License mới</h2><p class="muted">Chỉ admin được tạo. Email nhận Key phải có tài khoản trước.</p><form data-form="issue"><div class="field"><label>Email người nhận</label><input name="owner_email" type="email" required placeholder="khachhang@example.com"></div><div class="two-col" style="margin-top:12px"><div><label>Thời hạn (ngày)</label><input name="expires_days" type="number" min="1" max="3650" value="30" required></div><div><label>Số thiết bị</label><input name="device_limit" type="number" min="1" max="10" value="1" required></div></div><div class="field" style="margin-top:12px"><label>Ghi chú</label><input name="note" maxlength="200" placeholder="Gói 30 ngày"></div><div class="actions"><button class="btn" type="submit">Tạo Key</button>${btn('Trở lại danh sách','nav-keys')}</div></form></section>`;
  }
  function activatePanel() {
    return `<section class="panel"><h2>Kích hoạt License</h2><p class="muted">Dùng mã License được cấp cho email đang đăng nhập.</p><form data-form="activate"><div class="field"><label>Nhập mã License</label><input name="key" required minlength="30" autocomplete="off" placeholder="duyle-..."></div><div class="field"><label>Tên thiết bị</label><input name="label" maxlength="80" value="Safari trên iPhone"></div><div class="actions"><button class="btn" type="submit">Kích hoạt</button>${btn('Trở lại danh sách','nav-keys')}</div></form><p class="hint">Lưu ý: Mã thiết bị của bản web chỉ là ID do trình duyệt tạo ra, không phải bằng chứng nhận dạng thiết bị đáng tin cậy.</p></section>`;
  }
  function devicesPanel() {
    const descriptions = {activated:'Đã kích hoạt',renamed:'Đã đổi tên',removed:'Đã gỡ thiết bị'};
    const cards = devices.map(d => {
      const idAttr=`data-id="${esc(d.id)}"`;
      const editForm = editingDeviceId===d.id && me.is_admin ?
        `<form data-form="rename-device" class="device-edit"><input type="hidden" name="device_id" value="${esc(d.id)}"><div class="field"><label>Tên mới</label><input name="label" maxlength="80" required value="${esc(d.label)}" placeholder="Ví dụ: iPhone 13 - Khách A"></div><div class="actions"><button class="btn small" type="submit">Lưu tên</button>${btn('Hủy','cancel-edit-device','small alt')}</div></form>` : '';
      return `<div class="record"><div class="record-header"><div><div class="record-title">${esc(d.label||'Thiết bị chưa đặt tên')}</div><div class="record-meta">Mã máy KeyHub: <strong>${esc(d.device_code||'Chưa có')}</strong><br>Kích hoạt: ${fmt(d.created_at)}<br>Xác minh gần nhất: ${d.last_verified_at?fmt(d.last_verified_at):'Chưa ghi nhận'}</div></div></div><div class="actions">${d.device_code?btn('Sao chép mã máy','copy-device','small alt',`data-code="${esc(d.device_code)}"`):''}${me.is_admin?btn('Đổi tên','edit-device','small alt',idAttr):''}${btn('Gỡ thiết bị','delete-device','small danger',idAttr)}</div>${editForm}</div>`;
    }).join('');
    const history = showDeviceHistory ? `<div class="history"><h3>Lịch sử thay đổi</h3><p class="muted">Nhật ký bắt đầu ghi nhận từ lần nâng cấp. Các lần xác minh thường xuyên chỉ cập nhật thời gian gần nhất.</p>${deviceEvents.length?deviceEvents.map(event=>`<div class="record"><div class="record-title">${esc(descriptions[event.event_type]||event.event_type)}</div><div class="record-meta">${esc(event.label||'Thiết bị')} · ${esc(event.device_code)}<br>${fmt(event.created_at)}</div></div>`).join(''):'<div class="empty">Chưa có sự kiện nào được ghi nhận.</div>'}</div>` : '';
    return `<section class="panel"><h2>Quản lý thiết bị</h2><p class="muted">Mã máy KeyHub là mã riêng của hệ thống, không phải UDID phần cứng Apple. Tên thiết bị chỉ Admin mới sửa được.</p>${devices.length?cards:'<div class="empty">License này chưa được kích hoạt trên thiết bị nào.</div>'}<div class="actions">${btn(showDeviceHistory?'Ẩn lịch sử':'Xem lịch sử','toggle-device-history','alt')}${btn('Quay lại License','nav-keys')}</div>${history}</section>`;
  }
  function apiPanel() {
    return `<section class="panel"><h2>API Key</h2><p class="muted">Tạo API Key dùng cho tích hợp kỹ thuật. Hệ thống chỉ hiển thị giá trị bí mật một lần.</p><form data-form="create-api"><div class="field"><label>Tên API Key</label><input name="label" required maxlength="80" placeholder="Ứng dụng của tôi"></div><div class="actions"><button class="btn" type="submit">Tạo API Key mới</button>${btn('Tải lại','refresh-api')}</div></form>${apiKeys.length?apiKeys.map(k=>`<div class="record"><div class="record-header"><div><div class="record-title">${esc(k.label)}</div><div class="record-meta">${esc(k.prefix)}…<br>Tạo: ${fmt(k.created_at)}</div></div><span class="pill ${k.revoked_at?'off':''}">${k.revoked_at?'Đã thu hồi':'Hoạt động'}</span></div>${k.revoked_at?'':`<div class="actions">${btn('Thu hồi','revoke-api','small danger',`data-id="${esc(k.id)}"`)}</div>`}</div>`).join(''):'<div class="empty">Chưa có API Key nào.</div>'}</section>`;
  }
  function accountPanel() {
    return `<section class="panel"><h2>Thông tin tài khoản</h2><div class="record"><div class="record-title">${esc(me.email)}</div><div class="record-meta">Quyền: ${me.is_admin?'Quản trị viên':'Người dùng'}<br>Tham gia: ${fmt(me.created_at)}</div></div><div class="record-meta" style="margin-top:14px">Ghi nhớ đăng nhập: <strong>${rememberLogin?'Đang bật (thiết bị cá nhân)':'Đã tắt'}</strong></div><div class="actions">${btn('Đăng xuất','logout','danger')}${btn('Cấu hình API','settings')}</div></section><div class="notice">Website không lưu mật khẩu. Khi bật ghi nhớ, mã làm mới phiên được lưu trong bộ nhớ trình duyệt và có thể bị truy cập nếu trình duyệt hoặc website bị xâm nhập. Hãy đăng xuất trên thiết bị dùng chung.</div>`;
  }
  function secretPanel() {
    if(!revealed)return '';
    return `<section class="panel"><h2>${revealed.type==='license'?'License vừa cấp':'API Key vừa tạo'}</h2><div class="secret"><div class="warning"><strong>Chỉ hiển thị một lần. Hãy sao chép và cất giữ an toàn.</strong></div><code>${esc(revealed.value)}</code></div><div class="actions">${btn('Sao chép mã','copy-secret','')}${btn('Đã lưu, đóng','clear-secret')}</div></section>`;
  }
  function render() {
    if(tab==='settings') {app.innerHTML=settingsPanel();return;}
    if(tab==='register') {app.innerHTML=registerPanel();return;}
    if(!me) {app.innerHTML=authPanel();return;}
    let content;
    if(tab==='keys') content=licensesPanel();
    else if(tab==='api') content=apiPanel();
    else if(tab==='account') content=accountPanel();
    else if(tab==='issue') content=issuePanel();
    else if(tab==='activate') content=activatePanel();
    else if(tab==='devices') content=devicesPanel();
    else content=homePanel();
    const title={home:'Tổng quan',keys:'Danh sách License',api:'Quản lý API Key',account:'Tài khoản',issue:'Cấp License',activate:'Kích hoạt License',devices:'Thiết bị'}[tab]||'Tổng quan';
    const activationBanner = tab === 'keys' && activationResult ?
      `<section class="panel activation-result" role="status" aria-live="polite"><strong>✓ Kích hoạt thành công</strong><p>License: ${esc(activationResult.prefix)}…</p><p><strong>Hết hạn: ${fmt(activationResult.expires_at)} (giờ trên thiết bị)</strong></p><div class="actions">${btn('Đóng thông báo','dismiss-activation','alt')}</div></section>` : '';
    app.innerHTML=header(title)+`<main class="content">${secretPanel()}${activationBanner}${content}</main>`+menu();
    if (tab === 'keys') updateLicenseFilters();
  }
  async function loadData() {const results=await Promise.all([request('/keys'),request('/api-keys')]);licenses=results[0];apiKeys=results[1];}
  async function login(email,password,remember){ const t=await request('/auth/login','POST',{email,password});access=t.access_token;refresh=t.refresh_token;rememberLogin=Boolean(remember);persistSession();me=await request('/me');await loadData();tab='home';render();notify('Đăng nhập thành công.');}
  async function execForm(form) {
    const values=Object.fromEntries(new FormData(form));
    if(form.dataset.form==='settings') {
      const u=normalizedUrl(values.api_url);
      const original=apiUrl;apiUrl=u;
      try {const info=await request('/health');if(info.status!=='ok')throw Error('API không trả trạng thái ok.');}
      catch(e){apiUrl=original;throw e;}
      const changed = original !== u;
      localStorage.setItem(KEYS.url,u);
      if (changed) { clearSession(); tab='signin'; }
      else tab=me?'home':'signin';
      render();notify('Kết nối API thành công.');return;
    }
    if(form.dataset.form==='login') {await login(values.email,values.password,values.remember==='on');return;}
    if(form.dataset.form==='register') {await request('/auth/register','POST',{email:values.email,password:values.password});tab='signin';render();notify('Đăng ký thành công. Hãy đăng nhập.');return;}
    if(form.dataset.form==='issue') {const x=await request('/keys','POST',{owner_email:values.owner_email,expires_days:Number(values.expires_days),device_limit:Number(values.device_limit),note:values.note});revealed={type:'license',value:x.secret};await loadData();tab='keys';render();notify('Đã cấp License. Lưu mã ngay.');return;}
    if(form.dataset.form==='activate') {
      const activated = await request('/keys/activate','POST',
        {key:values.key.trim(),device_id:deviceId,label:values.label});
      activationResult = {prefix: activated.prefix, expires_at: activated.expires_at};
      await loadData();tab='keys';render();notify('Đã kích hoạt License.');return;
    }
    if(form.dataset.form==='rename-device') {
      const label=String(values.label||'').trim();
      if(!label)throw Error('Hãy nhập tên thiết bị.');
      await request('/keys/'+encodeURIComponent(viewedKey)+'/devices/'+encodeURIComponent(values.device_id)+'/rename','POST',{label});
      devices=await request('/keys/'+encodeURIComponent(viewedKey)+'/devices');
      if(showDeviceHistory)deviceEvents=await request('/keys/'+encodeURIComponent(viewedKey)+'/devices/history');
      editingDeviceId='';render();notify('Đã đổi tên thiết bị.');return;
    }
    if(form.dataset.form==='create-api') {const x=await request('/api-keys','POST',{label:values.label.trim()});revealed={type:'api',value:x.secret};await loadData();tab='api';render();notify('Đã tạo API Key. Lưu mã ngay.');return;}
  }
  app.addEventListener('submit',async e=>{
    if(!e.target.matches('form[data-form]'))return;
    e.preventDefault();if(busy)return;busy=true;
    const submit=e.target.querySelector('[type=submit]');if(submit)submit.disabled=true;
    const isActivation = e.target.dataset.form === 'activate';
    if (isActivation && submit) {
      submit.classList.add('is-loading');
      submit.textContent = 'Đang kiểm tra License…';
      e.target.setAttribute('aria-busy','true');
    }
    try {await execForm(e.target);} catch(err){notify(err.message||'Có lỗi xảy ra',true);} finally {
      busy=false;
      if (submit && submit.isConnected) {
        submit.disabled=false;
        if (isActivation) {
          submit.classList.remove('is-loading');
          submit.textContent='Kích hoạt';
          e.target.removeAttribute('aria-busy');
        }
      }
    }
  });
  app.addEventListener('input', e => {
    if (e.target.matches('[data-filter="license-query"]')) {
      licenseQuery = e.target.value;
      updateLicenseFilters();
    }
  });
  app.addEventListener('change', e => {
    if (e.target.matches('[data-filter="license-status"]')) {
      licenseStatus = e.target.value;
      updateLicenseFilters();
    }
  });
  app.addEventListener('click',async e=>{
    const button=e.target.closest('[data-action]');if(!button||busy)return;
    const action=button.dataset.action,id=button.dataset.id;
    if(action==='tab') {tab=button.dataset.tab;render();return;}
    const simple={settings:'settings',back:me?'home':'signin',signin:'signin',register:'register','nav-keys':'keys','nav-api':'api','nav-issue':'issue','nav-activate':'activate'};
    if(simple[action]){tab=simple[action];render();return;}
    if(action==='clear-secret'){revealed=null;render();return;}
    if(action==='dismiss-activation'){activationResult=null;render();return;}
    if(action==='retry-session' && refresh){app.innerHTML='<div class="loading-shell"><div class="spinner"></div>Đang khôi phục phiên…</div>';await restoreSession();return;}
    if(action==='copy-secret' && revealed){try{await navigator.clipboard.writeText(revealed.value);notify('Đã sao chép mã.');}catch{notify('Không thể sao chép tự động. Hãy chọn và sao chép mã.',true);}return;}
    if(action==='copy-device'){try{await navigator.clipboard.writeText(button.dataset.code||'');notify('Đã sao chép mã máy.');}catch{notify('Không thể sao chép. Hãy chọn mã hiển thị để sao chép.',true);}return;}
    if(action==='edit-device'){editingDeviceId=id;render();return;}
    if(action==='cancel-edit-device'){editingDeviceId='';render();return;}
    if(['revoke','revoke-api','delete-device'].includes(action)&&!confirm('Bạn xác nhận thực hiện thao tác này?'))return;
    if(action==='delete-license'){
      const item=licenses.find(x=>x.id===id);
      if(!me?.is_admin||!item||item.is_active){notify('Chỉ Admin được xóa License hết hạn hoặc đã thu hồi.',true);return;}
      if(!confirm('XÓA VĨNH VIỄN License '+item.prefix+'…?\nThiết bị và lịch sử của License cũng sẽ bị xóa. Không thể hoàn tác.'))return;
    }
    if(action==='delete-inactive-licenses'){
      if(!me?.is_admin){notify('Chỉ Admin được phép xóa.',true);return;}
      if(!confirm('XÓA VĨNH VIỄN mọi License hết hạn hoặc đã thu hồi (tối đa 500 mỗi lần)?\nThiết bị và lịch sử của các License cũng bị xóa. Không thể hoàn tác.'))return;
      if(prompt('Để xác nhận xóa hàng loạt, nhập chính xác XOA:')!=='XOA')return;
    }
    busy=true;button.disabled=true;
    try{
      if(action==='refresh'){licenses=await request('/keys');render();notify('Đã cập nhật License.');}
      if(action==='refresh-api'){apiKeys=await request('/api-keys');render();notify('Đã cập nhật API Key.');}
      if(action==='ping'){const info=await request('/health');notify(info.status==='ok'?'Máy chủ đang hoạt động.':'Phản hồi máy chủ không hợp lệ.',info.status!=='ok');}
      if(action==='devices'){viewedKey=id;devices=await request('/keys/'+encodeURIComponent(id)+'/devices');deviceEvents=[];showDeviceHistory=false;editingDeviceId='';tab='devices';render();}
      if(action==='toggle-device-history'){if(!showDeviceHistory)deviceEvents=await request('/keys/'+encodeURIComponent(viewedKey)+'/devices/history');showDeviceHistory=!showDeviceHistory;render();}
      if(action==='revoke'){await request('/keys/'+encodeURIComponent(id)+'/revoke','POST');licenses=await request('/keys');render();notify('Đã thu hồi License.');}
      if(action==='delete-license'){await request('/keys/'+encodeURIComponent(id),'DELETE');licenses=await request('/keys');render();notify('Đã xóa vĩnh viễn License và dữ liệu thiết bị liên quan.');}
      if(action==='delete-inactive-licenses'){const result=await request('/keys/inactive?confirm=true','DELETE');licenses=await request('/keys');render();notify('Đã xóa '+result.deleted+' License. Còn '+result.remaining+' License hết hạn/đã thu hồi.');}
      if(action==='delete-device'){await request('/keys/'+encodeURIComponent(viewedKey)+'/devices/'+encodeURIComponent(id),'DELETE');devices=await request('/keys/'+encodeURIComponent(viewedKey)+'/devices');if(showDeviceHistory)deviceEvents=await request('/keys/'+encodeURIComponent(viewedKey)+'/devices/history');licenses=await request('/keys');editingDeviceId='';render();notify('Đã gỡ thiết bị.');}
      if(action==='revoke-api'){await request('/api-keys/'+encodeURIComponent(id),'DELETE');apiKeys=await request('/api-keys');render();notify('Đã thu hồi API Key.');}
      if(action==='logout'){try{await request('/auth/logout','POST',{refresh_token:refresh});}catch{}clearSession();tab='signin';render();notify('Đã đăng xuất khỏi thiết bị này.');}
    }catch(err){notify(err.message||'Có lỗi xảy ra.',true);}finally{busy=false;if(button.isConnected)button.disabled=false;}
  });
  if (refresh) {
    app.innerHTML='<div class="loading-shell"><div class="spinner"></div>Đang khôi phục phiên đăng nhập…</div>';
    restoreSession();
  } else render();
  if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
})();
