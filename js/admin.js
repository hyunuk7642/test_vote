// =====================================================================
//  관리자(교사) 화면 로직 (admin.html)
// =====================================================================
//  - 로그인: Supabase 이메일+비밀번호
//  - 관리자 판정: DB 의 is_admin() 함수 (admins 표 + 익명 아님)
//  - 관리자는 RLS 정책 덕분에 표를 직접 읽고 쓸 수 있습니다.
//    (학생 화면과 달리 supabase.from(...) 을 바로 사용)
//
//  탭 구성: 대시보드 / 작품 / 학생 / 댓글 / 결과 / 교사 계정
// =====================================================================

(() => {
  'use strict';

  const { SUPABASE_URL, SUPABASE_ANON_KEY, BUCKET } = window.APP_CONFIG;

  // 메인 클라이언트 (관리자 세션을 브라우저에 저장)
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // 보조 클라이언트: "교사 추가"에서 다른 계정을 가입시킬 때 사용.
  // 세션을 저장하지 않아서 지금 로그인한 관리자 세션이 바뀌지 않습니다.
  const sbSignup = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const $ = (id) => document.getElementById(id);

  const state = {
    me: null,          // 로그인한 관리자 이메일
    settings: null,
    artworks: [],      // 관리자용 전체 목록 (숨긴 것 포함)
    students: [],
    comments: [],
    admins: [],
    csvRows: [],       // 불러온 작품 정보 CSV 행들 { title, author, description, keyword }
    uploads: [],       // 업로드 대기 목록 { file, previewUrl, title, author, description, status }
  };

  // -------------------------------------------------------------------
  // 공용 도우미
  // -------------------------------------------------------------------
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function imageUrl(path) { return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl; }
  function fmt(iso) {
    if (!iso) return '-';
    const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  let toastTimer;
  function toast(msg, ms = 2500) {
    const t = $('toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  function errMsg(e) { return (e && e.message) || String(e); }
  function showError(id, msg) { const p = $(id); p.textContent = msg; p.classList.remove('hidden'); }
  function hideError(id) { $(id).classList.add('hidden'); }

  // ---- CSV 만들기 / 내려받기 / 읽기 ----
  /** 2차원 배열 → CSV 문자열 (엑셀에서 한글이 깨지지 않도록 UTF-8 BOM 포함) */
  function toCSV(rows) {
    const cell = (v) => {
      const s = String(v ?? '');
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  }
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  /** CSV 문자열 → 2차원 배열 (따옴표 안의 쉼표·줄바꿈 처리) */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const rows = []; let row = []; let cur = ''; let inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }
  const today = () => new Date().toISOString().slice(0, 10);

  // -------------------------------------------------------------------
  // 1. 인증
  // -------------------------------------------------------------------

  // 로그인 화면 탭 (로그인 / 계정 만들기)
  document.querySelectorAll('[data-authtab]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-authtab]').forEach((x) => x.classList.toggle('is-active', x === b));
    $('loginForm').classList.toggle('hidden', b.dataset.authtab !== 'login');
    $('signupForm').classList.toggle('hidden', b.dataset.authtab !== 'signup');
  }));

  // 로그인
  $('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideError('loginError');
    $('btnLogin').disabled = true;
    try {
      const { error } = await sb.auth.signInWithPassword({
        email: $('loginEmail').value.trim(), password: $('loginPassword').value,
      });
      if (error) throw error;
      await enterApp();
    } catch (e) {
      showError('loginError', /Invalid login/i.test(errMsg(e)) ? '이메일 또는 비밀번호가 틀렸습니다.' : errMsg(e));
    } finally { $('btnLogin').disabled = false; }
  });

  // 관리자 계정 만들기: signUp → activate_admin_account(가입 코드) → 로그인
  $('signupForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideError('signupError');
    $('btnSignup').disabled = true;
    const email = $('signupEmail').value.trim(), password = $('signupPassword').value, code = $('signupCode').value;
    try {
      await createAdminAccount(sb, email, password, code);
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await enterApp();
    } catch (e) {
      showError('signupError', errMsg(e));
    } finally { $('btnSignup').disabled = false; }
  });

  /**
   * 계정 생성 + 활성화 + 관리자 등록 (로그인 화면과 "교사 추가"가 공용으로 사용)
   *  1) client.auth.signUp  → auth.users 에 계정 생성
   *  2) rpc activate_admin_account → 가입 코드 확인, 이메일 인증 처리, admins 등록
   */
  async function createAdminAccount(client, email, password, code) {
    if (!code.trim()) throw new Error('관리자 가입 코드를 입력하세요.');
    const { error: e1 } = await client.auth.signUp({ email, password });
    if (e1) {
      if (/already registered/i.test(e1.message)) {
        // 이미 있는 계정이면 가입 코드만 맞으면 관리자로 등록해 줌
      } else throw new Error(e1.message);
    }
    const { error: e2 } = await sb.rpc('activate_admin_account', { p_email: email, p_code: code });
    if (e2) throw new Error(e2.message);
  }

  $('btnLogout').addEventListener('click', async () => {
    await sb.auth.signOut();
    location.reload();
  });

  /** 로그인 후: 관리자인지 확인하고 앱 화면으로 */
  async function enterApp() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showAuth(); return; }

    const { data: isAdmin, error } = await sb.rpc('is_admin');
    if (error || !isAdmin) {
      await sb.auth.signOut();
      showAuth();
      showError('loginError', '이 계정은 관리자로 등록되어 있지 않습니다. "관리자 계정 만들기"에서 가입 코드를 입력해 등록하세요.');
      return;
    }
    state.me = (session.user.email || '').toLowerCase();
    $('meEmail').textContent = state.me;
    $('authScreen').classList.add('hidden');
    $('appScreen').classList.remove('hidden');
    await loadDashboard();
  }
  function showAuth() {
    $('appScreen').classList.add('hidden');
    $('authScreen').classList.remove('hidden');
  }

  // -------------------------------------------------------------------
  // 2. 탭 전환
  // -------------------------------------------------------------------
  const loaders = {
    dashboard: loadDashboard, artworks: loadArtworks, students: loadStudents,
    comments: loadComments, results: loadResults, admins: loadAdmins,
  };
  $('mainTabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('.tab'); if (!b) return;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('is-active', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
    loaders[b.dataset.tab]().catch((e) => toast(errMsg(e), 4000));
  });

  // -------------------------------------------------------------------
  // 3. 대시보드
  // -------------------------------------------------------------------
  async function loadDashboard() {
    // 숫자 4개 (head:true → 행은 안 받고 개수만)
    const count = (t) => sb.from(t).select('*', { count: 'exact', head: true }).then((r) => (r.error ? '!' : r.count));
    const [a, s, l, c] = await Promise.all([count('artworks'), count('students'), count('likes'), count('comments')]);
    $('statArtworks').textContent = a; $('statStudents').textContent = s;
    $('statLikes').textContent = l; $('statComments').textContent = c;

    const { data, error } = await sb.from('settings').select('*').eq('id', 1).single();
    if (error) throw error;
    state.settings = data;
    $('votingSwitch').checked = data.voting_open;
    $('votingLabel').textContent = data.voting_open ? '투표 진행 중' : '투표 마감';
    $('setTitle').value = data.site_title;
    $('setNotice').value = data.notice;
  }

  $('votingSwitch').addEventListener('change', async (ev) => {
    const open = ev.target.checked;
    const { error } = await sb.from('settings').update({ voting_open: open, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) { ev.target.checked = !open; toast('변경 실패: ' + error.message, 4000); return; }
    $('votingLabel').textContent = open ? '투표 진행 중' : '투표 마감';
    toast(open ? '투표를 시작했습니다' : '투표를 마감했습니다');
  });

  $('settingsForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const { error } = await sb.from('settings').update({
      site_title: $('setTitle').value.trim(), notice: $('setNotice').value.trim(), updated_at: new Date().toISOString(),
    }).eq('id', 1);
    if (error) { toast('저장 실패: ' + error.message, 4000); return; }
    toast('저장했습니다');
  });

  // -------------------------------------------------------------------
  // 4. 작품 - 업로드
  // -------------------------------------------------------------------
  const dropzone = $('dropzone'), fileInput = $('fileInput');
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault(); dropzone.classList.remove('is-over');
    addFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  /** 파일을 업로드 대기 목록에 추가 (CSV 가 있으면 파일명 키워드로 자동 매칭) */
  function addFiles(fileList) {
    [...fileList].forEach((file) => {
      if (!file.type.startsWith('image/')) { toast(`${file.name}: 이미지 파일만 올릴 수 있어요`); return; }
      if (file.size > 10 * 1024 * 1024) { toast(`${file.name}: 10MB 를 넘습니다`); return; }
      const item = { file, previewUrl: URL.createObjectURL(file), title: '', author: '', description: '', csvIndex: -1, status: '' };
      autoMatch(item);
      state.uploads.push(item);
    });
    renderUploads();
  }

  /** 파일명에 CSV 의 '파일명키워드'가 들어 있으면 그 행을 자동 선택 */
  function autoMatch(item) {
    const name = item.file.name.toLowerCase();
    const idx = state.csvRows.findIndex((r) => r.keyword && name.includes(r.keyword.toLowerCase()));
    if (idx >= 0) applyCsvRow(item, idx);
  }
  function applyCsvRow(item, idx) {
    item.csvIndex = idx;
    if (idx < 0) return;
    const r = state.csvRows[idx];
    item.title = r.title; item.author = r.author; item.description = r.description;
  }

  // CSV 불러오기 (열: 제목, 출품자, 설명, 파일명키워드 / 첫 행이 제목 행이면 건너뜀)
  $('csvInput').addEventListener('change', async (ev) => {
    const f = ev.target.files[0]; if (!f) return;
    const text = await readTextSmart(f);
    let rows = parseCSV(text);
    if (rows.length && /제목|title/i.test(rows[0][0] || '')) rows = rows.slice(1);
    state.csvRows = rows.map((r) => ({
      title: (r[0] || '').trim(), author: (r[1] || '').trim(), description: (r[2] || '').trim(), keyword: (r[3] || '').trim(),
    })).filter((r) => r.title);
    $('csvStatus').textContent = `CSV ${state.csvRows.length}행 불러옴`;
    state.uploads.forEach((it) => { if (it.csvIndex < 0) autoMatch(it); });
    renderUploads();
    ev.target.value = '';
  });

  /** CSV 파일 읽기: UTF-8 로 읽어 보고 깨진 글자가 많으면 EUC-KR 로 다시 시도 (엑셀 저장 파일 대응) */
  async function readTextSmart(file) {
    const buf = await file.arrayBuffer();
    const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (!utf8.includes('�')) return utf8;
    try { return new TextDecoder('euc-kr').decode(buf); } catch { return utf8; }
  }

  function renderUploads() {
    const list = $('uploadList');
    const opts = (sel) => `<option value="-1">CSV 에서 선택…</option>` +
      state.csvRows.map((r, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(r.title)} / ${esc(r.author)}</option>`).join('');

    list.innerHTML = state.uploads.map((it, i) => `
      <div class="upload-item ${it.status === 'done' ? 'is-done' : ''} ${it.status === 'error' ? 'is-error' : ''}" data-i="${i}">
        <img src="${it.previewUrl}" alt="" />
        <div class="upload-fields">
          <input type="text" placeholder="제목" data-f="title" value="${esc(it.title)}" />
          <input type="text" placeholder="출품자" data-f="author" value="${esc(it.author)}" />
          <textarea class="full" placeholder="작품 설명" data-f="description">${esc(it.description)}</textarea>
          <div class="upload-meta">
            <span>${esc(it.file.name)} · ${(it.file.size / 1024 / 1024).toFixed(1)}MB</span>
            ${state.csvRows.length ? `<select data-csv>${opts(it.csvIndex)}</select>` : ''}
            <span class="upload-status">${it.status === 'done' ? '✅ 완료' : it.status === 'error' ? '❌ ' + esc(it.error) : it.status === 'uploading' ? '⏳ 업로드 중' : ''}</span>
            <button type="button" class="btn btn-xs" data-remove>제거</button>
          </div>
        </div>
      </div>`).join('');
    $('btnUploadAll').disabled = !state.uploads.some((it) => it.status !== 'done');
  }

  // 업로드 목록 안의 입력/선택/제거 (이벤트 위임)
  $('uploadList').addEventListener('input', (ev) => {
    const box = ev.target.closest('.upload-item'); if (!box) return;
    const it = state.uploads[+box.dataset.i];
    if (ev.target.dataset.f) it[ev.target.dataset.f] = ev.target.value;
  });
  $('uploadList').addEventListener('change', (ev) => {
    const box = ev.target.closest('.upload-item'); if (!box) return;
    const it = state.uploads[+box.dataset.i];
    if (ev.target.hasAttribute('data-csv')) { applyCsvRow(it, +ev.target.value); renderUploads(); }
  });
  $('uploadList').addEventListener('click', (ev) => {
    const box = ev.target.closest('.upload-item'); if (!box) return;
    if (ev.target.closest('[data-remove]')) {
      const it = state.uploads.splice(+box.dataset.i, 1)[0];
      URL.revokeObjectURL(it.previewUrl);
      renderUploads();
    }
  });
  $('btnClearUploads').addEventListener('click', () => {
    state.uploads.forEach((it) => URL.revokeObjectURL(it.previewUrl));
    state.uploads = []; renderUploads(); $('uploadProgress').textContent = '';
  });

  /** 모두 업로드: Storage 에 파일 올리고 artworks 행 추가 */
  $('btnUploadAll').addEventListener('click', async () => {
    const targets = state.uploads.filter((it) => it.status !== 'done');
    if (!targets.length) return;
    if (targets.some((it) => !it.title.trim()) && !confirm('제목이 비어 있는 작품이 있습니다. 그대로 올릴까요?')) return;

    $('btnUploadAll').disabled = true;
    let done = 0;
    for (const it of targets) {
      it.status = 'uploading'; renderUploads();
      $('uploadProgress').textContent = `업로드 중… ${done}/${targets.length}`;
      try {
        const ext = (it.file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
        // 한글 파일명은 URL 에서 문제가 될 수 있어 날짜+난수로 새 이름을 만듭니다
        const path = `${new Date().getFullYear()}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const up = await sb.storage.from(BUCKET).upload(path, it.file, { contentType: it.file.type, upsert: false });
        if (up.error) throw up.error;
        const ins = await sb.from('artworks').insert({
          title: it.title.trim() || it.file.name, author: it.author.trim(), description: it.description.trim(),
          image_path: path, sort_order: state.artworks.length + done,
        });
        if (ins.error) {
          await sb.storage.from(BUCKET).remove([path]);   // 행 추가 실패 시 올린 파일도 정리
          throw ins.error;
        }
        it.status = 'done'; done++;
      } catch (e) {
        it.status = 'error'; it.error = errMsg(e);
      }
      renderUploads();
    }
    $('uploadProgress').textContent = `완료: ${done}/${targets.length}` + (done < targets.length ? ' (실패한 항목은 수정 후 다시 "모두 업로드")' : '');
    await loadArtworks();
  });

  // -------------------------------------------------------------------
  // 5. 작품 - 목록 (인라인 수정 · 숨김 · 삭제)
  // -------------------------------------------------------------------
  async function loadArtworks() {
    const { data, error } = await sb.from('artworks').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    state.artworks = data || [];
    $('artworkCount').textContent = `${state.artworks.length}개`;
    renderArtworks();
  }
  $('btnReloadArtworks').addEventListener('click', () => loadArtworks().catch((e) => toast(errMsg(e))));

  function renderArtworks() {
    const list = $('artworkList');
    if (!state.artworks.length) { list.innerHTML = '<p class="muted">등록된 작품이 없습니다.</p>'; return; }
    list.innerHTML = state.artworks.map((a) => `
      <div class="artwork-item ${a.hidden ? 'is-hidden' : ''}" data-id="${a.id}">
        <a href="${esc(imageUrl(a.image_path))}" target="_blank" rel="noopener"><img src="${esc(imageUrl(a.image_path))}" alt="" loading="lazy" /></a>
        <div class="artwork-fields">
          <input type="text" placeholder="제목" data-f="title" value="${esc(a.title)}" />
          <input type="text" placeholder="출품자" data-f="author" value="${esc(a.author)}" />
          <textarea class="full" placeholder="작품 설명" data-f="description">${esc(a.description)}</textarea>
          <div class="artwork-actions">
            <button type="button" class="btn btn-xs btn-primary" data-save>저장</button>
            <button type="button" class="btn btn-xs" data-toggle>${a.hidden ? '보이기' : '숨기기'}</button>
            <button type="button" class="btn btn-xs btn-danger" data-delete>삭제</button>
            ${a.hidden ? '<span class="tag hidden-tag">숨김</span>' : ''}
            <span class="muted">${fmt(a.created_at)}</span>
          </div>
        </div>
      </div>`).join('');
  }

  $('artworkList').addEventListener('click', async (ev) => {
    const box = ev.target.closest('.artwork-item'); if (!box) return;
    const id = box.dataset.id;
    const a = state.artworks.find((x) => x.id === id);
    const val = (f) => box.querySelector(`[data-f="${f}"]`).value.trim();

    try {
      if (ev.target.closest('[data-save]')) {
        const { error } = await sb.from('artworks').update({
          title: val('title'), author: val('author'), description: val('description'), updated_at: new Date().toISOString(),
        }).eq('id', id);
        if (error) throw error;
        toast('저장했습니다'); await loadArtworks();
      } else if (ev.target.closest('[data-toggle]')) {
        const { error } = await sb.from('artworks').update({ hidden: !a.hidden }).eq('id', id);
        if (error) throw error;
        await loadArtworks();
      } else if (ev.target.closest('[data-delete]')) {
        if (!confirm(`"${a.title}" 작품을 삭제할까요?\n이미지 파일과 하트·댓글이 모두 삭제됩니다.`)) return;
        const { error } = await sb.from('artworks').delete().eq('id', id);
        if (error) throw error;
        const rm = await sb.storage.from(BUCKET).remove([a.image_path]);
        if (rm.error) toast('행은 지웠지만 이미지 파일 삭제에 실패했습니다: ' + rm.error.message, 4000);
        else toast('삭제했습니다');
        await loadArtworks();
      }
    } catch (e) { toast('실패: ' + errMsg(e), 4000); }
  });

  // -------------------------------------------------------------------
  // 6. 학생
  // -------------------------------------------------------------------
  async function loadStudents() {
    const { data, error } = await sb.from('students').select('*').order('last_login_at', { ascending: false });
    if (error) throw error;
    state.students = data || [];
    renderStudents();
  }
  $('btnReloadStudents').addEventListener('click', () => loadStudents().catch((e) => toast(errMsg(e))));
  $('studentSearch').addEventListener('input', renderStudents);

  function filteredStudents() {
    const q = $('studentSearch').value.trim().toLowerCase();
    if (!q) return state.students;
    return state.students.filter((s) => [s.school, s.student_no, s.name].some((v) => String(v).toLowerCase().includes(q)));
  }

  function renderStudents() {
    const rows = filteredStudents();
    $('studentCount').textContent = `${rows.length}명` + (rows.length !== state.students.length ? ` / 전체 ${state.students.length}명` : '');
    const tb = $('studentTable').querySelector('tbody');
    if (!rows.length) { tb.innerHTML = '<tr class="empty-row"><td colspan="6">학생이 없습니다</td></tr>'; return; }
    tb.innerHTML = rows.map((s) => `
      <tr data-id="${s.id}">
        <td>${esc(s.school)}</td><td class="nowrap">${esc(s.student_no)}</td><td class="nowrap">${esc(s.name)}</td>
        <td class="nowrap">${fmt(s.last_login_at)}</td>
        <td class="nowrap">${s.user_id ? '연결됨' : '<span class="muted">해제됨</span>'}</td>
        <td class="actions">
          <button type="button" class="btn btn-xs" data-unlink ${s.user_id ? '' : 'disabled'}>기기 해제</button>
          <button type="button" class="btn btn-xs btn-danger" data-delete>삭제</button>
        </td>
      </tr>`).join('');
  }

  $('studentTable').addEventListener('click', async (ev) => {
    const tr = ev.target.closest('tr[data-id]'); if (!tr) return;
    const s = state.students.find((x) => x.id === tr.dataset.id);
    try {
      if (ev.target.closest('[data-unlink]')) {
        const { error } = await sb.from('students').update({ user_id: null }).eq('id', s.id);
        if (error) throw error;
        toast('기기 연결을 해제했습니다'); await loadStudents();
      } else if (ev.target.closest('[data-delete]')) {
        if (!confirm(`${s.school} ${s.student_no} ${s.name} 학생을 삭제할까요?\n이 학생의 하트와 댓글도 모두 삭제됩니다.`)) return;
        const { error } = await sb.from('students').delete().eq('id', s.id);
        if (error) throw error;
        toast('삭제했습니다'); await loadStudents();
      }
    } catch (e) { toast('실패: ' + errMsg(e), 4000); }
  });

  $('btnStudentsCsv').addEventListener('click', () => {
    const rows = [['학교', '학번', '이름', '처음 로그인', '마지막 로그인', '기기 연결']];
    filteredStudents().forEach((s) => rows.push([s.school, s.student_no, s.name, fmt(s.created_at), fmt(s.last_login_at), s.user_id ? '연결됨' : '해제됨']));
    downloadText(`학생목록_${today()}.csv`, toCSV(rows));
  });

  // -------------------------------------------------------------------
  // 7. 댓글
  // -------------------------------------------------------------------
  async function loadComments() {
    // students / artworks 는 외래키로 연결돼 있어 한 번에 함께 가져올 수 있음 (PostgREST 임베딩)
    const { data, error } = await sb.from('comments')
      .select('id, content, hidden, created_at, artwork_id, students(school, student_no, name), artworks(title)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    state.comments = data || [];
    renderComments();
  }
  $('btnReloadComments').addEventListener('click', () => loadComments().catch((e) => toast(errMsg(e))));
  $('onlyHidden').addEventListener('change', renderComments);

  function renderComments() {
    const only = $('onlyHidden').checked;
    const rows = state.comments.filter((c) => !only || c.hidden);
    $('commentCountAdmin').textContent = `${rows.length}개`;
    const tb = $('commentTable').querySelector('tbody');
    if (!rows.length) { tb.innerHTML = '<tr class="empty-row"><td colspan="6">댓글이 없습니다</td></tr>'; return; }
    tb.innerHTML = rows.map((c) => {
      const st = c.students || {}, aw = c.artworks || {};
      return `
      <tr data-id="${c.id}" class="${c.hidden ? 'is-hidden' : ''}">
        <td class="nowrap">${fmt(c.created_at)}</td>
        <td>${esc(aw.title ?? '(삭제된 작품)')}</td>
        <td class="nowrap">${esc(st.name ?? '(삭제됨)')}<br><span class="muted">${esc(st.school ?? '')} ${esc(st.student_no ?? '')}</span></td>
        <td>${esc(c.content)}</td>
        <td class="nowrap">${c.hidden ? '<span class="tag hidden-tag">숨김</span>' : '<span class="tag">보임</span>'}</td>
        <td class="actions">
          <button type="button" class="btn btn-xs" data-toggle>${c.hidden ? '보이기' : '숨기기'}</button>
          <button type="button" class="btn btn-xs btn-danger" data-delete>삭제</button>
        </td>
      </tr>`;
    }).join('');
  }

  $('commentTable').addEventListener('click', async (ev) => {
    const tr = ev.target.closest('tr[data-id]'); if (!tr) return;
    const c = state.comments.find((x) => x.id === tr.dataset.id);
    try {
      if (ev.target.closest('[data-toggle]')) {
        const { error } = await sb.from('comments').update({ hidden: !c.hidden }).eq('id', c.id);
        if (error) throw error;
        await loadComments();
      } else if (ev.target.closest('[data-delete]')) {
        if (!confirm('이 댓글을 완전히 삭제할까요?')) return;
        const { error } = await sb.from('comments').delete().eq('id', c.id);
        if (error) throw error;
        toast('삭제했습니다'); await loadComments();
      }
    } catch (e) { toast('실패: ' + errMsg(e), 4000); }
  });

  // -------------------------------------------------------------------
  // 8. 결과 (순위 + CSV 3종)
  // -------------------------------------------------------------------
  const results = { artworks: [], likes: [], comments: [] };

  async function loadResults() {
    const [a, l, c] = await Promise.all([
      sb.from('artworks').select('id, title, author, hidden, created_at').order('created_at'),
      sb.from('likes').select('artwork_id, created_at, students(school, student_no, name)').order('created_at'),
      sb.from('comments').select('artwork_id, content, hidden, created_at, students(school, student_no, name)').order('created_at'),
    ]);
    if (a.error) throw a.error; if (l.error) throw l.error; if (c.error) throw c.error;
    results.artworks = a.data || []; results.likes = l.data || []; results.comments = c.data || [];
    renderResults();
  }
  $('btnReloadResults').addEventListener('click', () => loadResults().catch((e) => toast(errMsg(e))));

  /** 작품별 집계 배열 (하트 많은 순) */
  function summaryRows() {
    const likeCnt = {}, cmtCnt = {};
    results.likes.forEach((l) => { likeCnt[l.artwork_id] = (likeCnt[l.artwork_id] || 0) + 1; });
    results.comments.forEach((c) => { if (!c.hidden) cmtCnt[c.artwork_id] = (cmtCnt[c.artwork_id] || 0) + 1; });
    return results.artworks
      .map((a) => ({ ...a, likes: likeCnt[a.id] || 0, comments: cmtCnt[a.id] || 0 }))
      .sort((x, y) => (y.likes - x.likes) || (y.comments - x.comments) || (new Date(x.created_at) - new Date(y.created_at)))
      .map((r, i, arr) => ({ ...r, rank: (i > 0 && arr[i - 1].likes === r.likes) ? arr[i - 1].rank : i + 1 }));  // 동점은 같은 순위
  }

  function renderResults() {
    const rows = summaryRows();
    const tb = $('resultTable').querySelector('tbody');
    if (!rows.length) { tb.innerHTML = '<tr class="empty-row"><td colspan="6">작품이 없습니다</td></tr>'; return; }
    tb.innerHTML = rows.map((r) => `
      <tr class="${r.rank === 1 ? 'rank-1' : ''}">
        <td class="nowrap">${r.rank}</td><td>${esc(r.title)}</td><td>${esc(r.author)}</td>
        <td class="nowrap">♥ ${r.likes}</td><td class="nowrap">${r.comments}</td>
        <td class="nowrap">${r.hidden ? '<span class="tag hidden-tag">숨김</span>' : ''}</td>
      </tr>`).join('');
  }

  const titleOf = (id) => (results.artworks.find((a) => a.id === id) || {}).title || '(삭제된 작품)';
  const st = (row) => row.students || { school: '(삭제됨)', student_no: '', name: '' };

  $('btnCsvSummary').addEventListener('click', () => {
    const rows = [['순위', '제목', '출품자', '하트 수', '댓글 수', '숨김 여부']];
    summaryRows().forEach((r) => rows.push([r.rank, r.title, r.author, r.likes, r.comments, r.hidden ? '숨김' : '']));
    downloadText(`작품별집계_${today()}.csv`, toCSV(rows));
  });
  $('btnCsvLikes').addEventListener('click', () => {
    const rows = [['시각', '작품', '학교', '학번', '이름']];
    results.likes.forEach((l) => rows.push([fmt(l.created_at), titleOf(l.artwork_id), st(l).school, st(l).student_no, st(l).name]));
    downloadText(`하트상세_${today()}.csv`, toCSV(rows));
  });
  $('btnCsvComments').addEventListener('click', () => {
    const rows = [['시각', '작품', '학교', '학번', '이름', '내용', '숨김 여부']];
    results.comments.forEach((c) => rows.push([fmt(c.created_at), titleOf(c.artwork_id), st(c).school, st(c).student_no, st(c).name, c.content, c.hidden ? '숨김' : '']));
    downloadText(`댓글상세_${today()}.csv`, toCSV(rows));
  });

  // -------------------------------------------------------------------
  // 9. 교사 계정
  // -------------------------------------------------------------------
  async function loadAdmins() {
    const { data, error } = await sb.from('admins').select('*').order('created_at');
    if (error) throw error;
    state.admins = data || [];
    $('adminList').innerHTML = state.admins.map((a) => `
      <li data-email="${esc(a.email)}">
        <span>${esc(a.email)} ${a.email === state.me ? '<span class="tag">나</span>' : ''}<br><span class="muted">${fmt(a.created_at)}</span></span>
        ${a.email === state.me ? '' : '<button type="button" class="btn btn-xs btn-danger" data-remove>권한 해제</button>'}
      </li>`).join('');
  }

  $('adminList').addEventListener('click', async (ev) => {
    const li = ev.target.closest('li[data-email]'); if (!li || !ev.target.closest('[data-remove]')) return;
    const email = li.dataset.email;
    if (!confirm(`${email} 의 관리자 권한을 해제할까요?\n(로그인 계정 자체는 남고, 관리자 기능만 못 쓰게 됩니다)`)) return;
    const { error } = await sb.from('admins').delete().eq('email', email);
    if (error) { toast('실패: ' + error.message, 4000); return; }
    toast('해제했습니다'); await loadAdmins();
  });

  $('addAdminForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    hideError('addAdminError');
    $('btnAddAdmin').disabled = true;
    try {
      // 보조 클라이언트로 가입 → 현재 관리자 세션은 그대로 유지
      await createAdminAccount(sbSignup, $('addEmail').value.trim(), $('addPassword').value, $('addCode').value);
      $('addAdminForm').reset();
      toast('교사 계정을 추가했습니다');
      await loadAdmins();
    } catch (e) {
      showError('addAdminError', errMsg(e));
    } finally { $('btnAddAdmin').disabled = false; }
  });

  // -------------------------------------------------------------------
  // 10. 시작: 세션이 남아 있으면 바로 앱 화면으로
  // -------------------------------------------------------------------
  enterApp().catch((e) => { console.error(e); showAuth(); });
})();
