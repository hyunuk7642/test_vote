// =====================================================================
//  학생 화면 로직 (index.html)
// =====================================================================
//  흐름
//    1) 페이지 열기 → 설정(제목·안내문·투표 상태) + 작품 목록 + 집계 불러오기
//    2) 로그인 전에도 갤러리는 볼 수 있음
//    3) 하트/댓글을 누르면 로그인 모달 → 익명 로그인 + claim_student
//    4) 하트: 화면 먼저 바꾸고(낙관적 업데이트) 서버에 toggle_like 호출, 실패하면 되돌림
//    5) 댓글: add_comment / delete_my_comment 함수 호출
//
//  DB 쓰기는 전부 supabase.rpc(...) 로만 합니다 (RLS 가 직접 쓰기를 막음).
// =====================================================================

(() => {
  'use strict';

  // -------------------------------------------------------------------
  // 0. 준비: Supabase 클라이언트, 상태, DOM 참조
  // -------------------------------------------------------------------
  const { SUPABASE_URL, SUPABASE_ANON_KEY, BUCKET } = window.APP_CONFIG;
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // 화면 전체에서 공유하는 상태
  const state = {
    settings: null,      // { site_title, notice, voting_open }
    artworks: [],        // 작품 목록 (hidden=false 만 내려옴)
    stats: {},           // artwork_id → { like_count, comment_count, liked_by_me }
    profile: null,       // 로그인한 학생 { id, school, student_no, name } 또는 null
    sort: 'random',      // 'random' | 'popular' | 'newest'
    seed: getSessionSeed(),
    current: null,       // 상세 모달에 열린 작품
    comments: [],        // 상세 모달의 댓글 목록
    pending: new Set(),  // 서버 응답을 기다리는 작품 id (하트 연타 방지)
    loaded: false,       // 첫 불러오기 성공 여부 (실패 화면을 덮어쓰지 않기 위해)
  };

  // 자주 쓰는 DOM 요소를 한 번에 모아 둠
  const $ = (id) => document.getElementById(id);
  const el = {
    siteTitle: $('siteTitle'), authArea: $('authArea'), notice: $('notice'),
    votingBadge: $('votingBadge'), countText: $('countText'),
    gallery: $('gallery'), emptyBox: $('emptyBox'), errorBox: $('errorBox'), errorText: $('errorText'),
    // 상세 모달
    detailModal: $('detailModal'), detailImage: $('detailImage'), detailTitle: $('detailTitle'),
    detailAuthor: $('detailAuthor'), detailDesc: $('detailDesc'), detailHeart: $('detailHeart'),
    detailHeartCount: $('detailHeartCount'), detailClosedText: $('detailClosedText'),
    commentCount: $('commentCount'), commentList: $('commentList'), commentEmpty: $('commentEmpty'),
    commentForm: $('commentForm'), commentInput: $('commentInput'), charCount: $('charCount'),
    btnComment: $('btnComment'), commentClosedText: $('commentClosedText'), commentLoginHint: $('commentLoginHint'),
    // 로그인 모달
    loginModal: $('loginModal'), loginForm: $('loginForm'), inSchool: $('inSchool'),
    inStudentNo: $('inStudentNo'), inName: $('inName'), inConsent: $('inConsent'),
    loginError: $('loginError'), btnLogin: $('btnLogin'),
    toast: $('toast'),
  };

  // -------------------------------------------------------------------
  // 1. 작은 도우미 함수들
  // -------------------------------------------------------------------

  /** HTML 에 끼워 넣을 문자열을 안전하게 바꿈 (XSS 방지) */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Storage 공개 URL 만들기 */
  function imageUrl(path) {
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  /** 세션 동안 고정되는 랜덤 시드 (탭을 닫기 전까지 순서가 유지됨) */
  function getSessionSeed() {
    try {
      let s = sessionStorage.getItem('gallery_seed');
      if (!s) {
        s = String(Math.floor(Math.random() * 1e9));
        sessionStorage.setItem('gallery_seed', s);
      }
      return s;
    } catch { return '1'; }
  }

  /** 문자열 → 숫자 해시 (랜덤 정렬에 사용, 시드가 같으면 결과도 같음) */
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** 날짜를 "10/08 14:30" 식으로 */
  function fmtTime(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 짧은 알림 */
  let toastTimer = null;
  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), ms);
  }

  /** Supabase 오류 → 사람이 읽을 메시지 */
  function friendlyError(err) {
    const m = (err && err.message) || String(err);
    if (/rate limit/i.test(m)) return '잠시 후 다시 시도해 주세요. (접속이 몰리고 있어요)';
    if (/Failed to fetch|NetworkError/i.test(m)) return '인터넷 연결을 확인해 주세요.';
    if (/Anonymous sign-ins are disabled/i.test(m)) return '로그인 기능이 꺼져 있어요. 선생님께 알려 주세요.';
    return m;
  }

  /** 모달 열기/닫기 */
  function openModal(modal) {
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }
  function closeModal(modal) {
    modal.classList.add('hidden');
    if (!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('modal-open');
  }

  const votingOpen = () => !!(state.settings && state.settings.voting_open);

  // -------------------------------------------------------------------
  // 2. 데이터 불러오기
  // -------------------------------------------------------------------

  /** 설정 1행 (제목·안내문·투표 상태) */
  async function loadSettings() {
    const { data, error } = await sb.from('settings').select('site_title, notice, voting_open').eq('id', 1).single();
    if (error) throw error;
    state.settings = data;
    renderSettings();
  }

  /** 작품 목록 + 집계 */
  async function loadArtworks() {
    const [a, s] = await Promise.all([
      sb.from('artworks').select('id, title, author, description, image_path, created_at').order('created_at', { ascending: false }),
      sb.rpc('get_artwork_stats'),
    ]);
    if (a.error) throw a.error;
    if (s.error) throw s.error;
    state.artworks = a.data || [];
    state.stats = {};
    (s.data || []).forEach((r) => { state.stats[r.artwork_id] = r; });
  }

  /** 집계만 다시 (하트 수가 바뀌었을 수 있으니 가끔 새로고침) */
  async function refreshStats() {
    if (!state.loaded) return;
    const { data, error } = await sb.rpc('get_artwork_stats');
    if (error) return;
    const next = {};
    (data || []).forEach((r) => { next[r.artwork_id] = r; });
    // 서버 응답을 기다리는 작품은 화면 값을 유지 (깜빡임 방지)
    state.pending.forEach((id) => { if (state.stats[id]) next[id] = state.stats[id]; });
    state.stats = next;
    renderGallery();
    if (state.current) renderDetailHeart();
  }

  /** 세션이 있으면 연결된 학생 프로필 복원 */
  async function restoreProfile() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { state.profile = null; return; }
    const { data, error } = await sb.rpc('get_my_profile');
    state.profile = (!error && data) ? data : null;

    // 전에 로그인했던 기록은 있는데 지금 연결이 없다 → 다른 기기에서 로그인한 경우
    if (!state.profile && localStorage.getItem('vote_profile')) {
      localStorage.removeItem('vote_profile');
      toast('다른 기기에서 로그인되어 이 기기의 연결이 해제됐어요. 다시 로그인해 주세요.', 4000);
    }
  }

  // -------------------------------------------------------------------
  // 3. 화면 그리기
  // -------------------------------------------------------------------

  function renderSettings() {
    const s = state.settings;
    el.siteTitle.textContent = s.site_title;
    document.title = s.site_title;
    el.notice.textContent = s.notice;
    el.votingBadge.textContent = s.voting_open ? '투표 진행 중' : '투표 마감';
    el.votingBadge.className = 'badge ' + (s.voting_open ? 'open' : 'closed');
  }

  function renderAuth() {
    if (state.profile) {
      el.authArea.innerHTML = `
        <span class="user-chip"><b>${esc(state.profile.name)}</b> · ${esc(state.profile.school)}</span>
        <button class="btn btn-outline btn-sm" id="btnLogout" type="button">로그아웃</button>`;
      $('btnLogout').addEventListener('click', logout);
    } else {
      el.authArea.innerHTML = `<button class="btn btn-primary btn-sm" id="btnOpenLogin" type="button">로그인</button>`;
      $('btnOpenLogin').addEventListener('click', () => openModal(el.loginModal));
    }
  }

  /** 정렬 방식에 따라 작품 배열 정렬 */
  function sortedArtworks() {
    const list = [...state.artworks];
    const rnd = (a) => hash(state.seed + ':' + a.id);
    if (state.sort === 'popular') {
      list.sort((a, b) => (likeCount(b) - likeCount(a)) || (rnd(a) - rnd(b)));
    } else if (state.sort === 'newest') {
      list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    } else {
      list.sort((a, b) => rnd(a) - rnd(b));
    }
    return list;
  }
  const likeCount = (a) => Number((state.stats[a.id] || {}).like_count || 0);
  const commentCount = (a) => Number((state.stats[a.id] || {}).comment_count || 0);
  const likedByMe = (a) => !!(state.stats[a.id] || {}).liked_by_me;

  function renderGallery() {
    el.emptyBox.classList.add('hidden');
    el.errorBox.classList.add('hidden');

    if (state.artworks.length === 0) {
      el.gallery.innerHTML = '';
      el.emptyBox.classList.remove('hidden');
      el.countText.textContent = '';
      return;
    }

    const open = votingOpen();
    el.countText.textContent = `작품 ${state.artworks.length}개`;

    el.gallery.innerHTML = sortedArtworks().map((a) => `
      <article class="card" data-id="${a.id}">
        <img class="card-image" src="${esc(imageUrl(a.image_path))}" alt="${esc(a.title)}" loading="lazy" data-open />
        <div class="card-body">
          <h2 class="card-title" data-open>${esc(a.title)}</h2>
          <p class="card-author">${esc(a.author)}</p>
          <p class="card-desc" data-open>${esc(a.description)}</p>
          <div class="card-footer">
            <button class="heart-btn ${likedByMe(a) ? 'liked' : ''}" type="button" data-heart
                    ${open ? '' : 'disabled title="투표가 마감되었습니다"'}>
              <span class="heart-icon">♥</span>
              <span class="heart-count">${likeCount(a)}</span>
            </button>
            <button class="comment-pill" type="button" data-open>댓글 ${commentCount(a)}</button>
          </div>
        </div>
      </article>`).join('');
  }

  // -------------------------------------------------------------------
  // 4. 상세 모달
  // -------------------------------------------------------------------

  async function openDetail(id) {
    const a = state.artworks.find((x) => x.id === id);
    if (!a) return;
    state.current = a;

    el.detailImage.src = imageUrl(a.image_path);
    el.detailImage.alt = a.title;
    el.detailTitle.textContent = a.title;
    el.detailAuthor.textContent = a.author;
    el.detailDesc.textContent = a.description;
    renderDetailHeart();

    // 댓글 영역: 투표 상태/로그인 상태에 따라 보여 줄 것 결정
    el.commentList.innerHTML = '';
    el.commentEmpty.classList.add('hidden');
    el.commentInput.value = '';
    el.charCount.textContent = '0';
    renderCommentFormState();

    openModal(el.detailModal);
    await loadComments(id);
  }

  function renderDetailHeart() {
    const a = state.current;
    if (!a) return;
    const open = votingOpen();
    el.detailHeart.classList.toggle('liked', likedByMe(a));
    el.detailHeartCount.textContent = likeCount(a);
    el.detailHeart.disabled = !open;
    el.detailClosedText.classList.toggle('hidden', open);
  }

  function renderCommentFormState() {
    const open = votingOpen();
    el.commentForm.classList.toggle('hidden', !(open && state.profile));
    el.commentClosedText.classList.toggle('hidden', open);
    el.commentLoginHint.classList.toggle('hidden', !(open && !state.profile));
  }

  async function loadComments(artworkId) {
    const { data, error } = await sb.rpc('get_comments', { p_artwork_id: artworkId });
    if (state.current?.id !== artworkId) return;   // 그 사이 다른 작품을 열었으면 무시
    if (error) { toast('댓글을 불러오지 못했어요'); return; }
    state.comments = data || [];
    renderComments();
  }

  function renderComments() {
    const list = state.comments;
    el.commentCount.textContent = list.length;
    el.commentEmpty.classList.toggle('hidden', list.length > 0);
    el.commentList.innerHTML = list.map((c) => `
      <li class="comment-item" data-cid="${c.id}">
        <div class="comment-head">
          <span class="comment-name">${esc(c.masked_name)}</span>
          <span>
            <span class="comment-time">${fmtTime(c.created_at)}</span>
            ${c.is_mine && votingOpen() ? '<button class="comment-del" type="button" data-del>삭제</button>' : ''}
          </span>
        </div>
        <p class="comment-text">${esc(c.content)}</p>
      </li>`).join('');

    // 작품 카드의 댓글 수도 맞춰 줌
    if (state.current && state.stats[state.current.id]) {
      state.stats[state.current.id].comment_count = list.length;
      const pill = el.gallery.querySelector(`.card[data-id="${state.current.id}"] .comment-pill`);
      if (pill) pill.textContent = `댓글 ${list.length}`;
    }
  }

  // -------------------------------------------------------------------
  // 5. 하트 (낙관적 업데이트)
  // -------------------------------------------------------------------

  async function toggleLike(artworkId) {
    if (!votingOpen()) { toast('투표가 마감되었어요'); return; }
    if (!state.profile) { openModal(el.loginModal); return; }
    if (state.pending.has(artworkId)) return;   // 연타 방지

    const stat = state.stats[artworkId] || (state.stats[artworkId] = { like_count: 0, comment_count: 0, liked_by_me: false });
    const before = { like_count: Number(stat.like_count), liked_by_me: stat.liked_by_me };

    // 1) 화면 먼저 바꾸기
    stat.liked_by_me = !stat.liked_by_me;
    stat.like_count = before.like_count + (stat.liked_by_me ? 1 : -1);
    paintHeart(artworkId, true);

    // 2) 서버 호출
    state.pending.add(artworkId);
    const { data, error } = await sb.rpc('toggle_like', { p_artwork_id: artworkId });
    state.pending.delete(artworkId);

    if (error) {
      // 3) 실패 → 되돌리고 이유 알려 주기
      stat.liked_by_me = before.liked_by_me;
      stat.like_count = before.like_count;
      paintHeart(artworkId, false);
      const msg = friendlyError(error);
      toast(msg, 3500);
      if (/로그인이 필요/.test(msg)) await handleUnlinked();
      if (/투표 기간/.test(msg)) await safe(loadSettings).then(renderGallery).then(renderDetailHeart);
      return;
    }
    // 서버가 알려 준 정확한 값으로 맞춤
    stat.liked_by_me = data.liked;
    stat.like_count = Number(data.count);
    paintHeart(artworkId, false);
  }

  /** 특정 작품의 하트 버튼(카드 + 상세)만 다시 칠함 */
  function paintHeart(artworkId, animate) {
    const a = { id: artworkId };
    const btns = [...el.gallery.querySelectorAll(`.card[data-id="${artworkId}"] .heart-btn`)];
    if (state.current && state.current.id === artworkId) btns.push(el.detailHeart);
    btns.forEach((b) => {
      b.classList.toggle('liked', likedByMe(a));
      b.querySelector('.heart-count').textContent = likeCount(a);
      if (animate) {
        b.classList.remove('pop');
        void b.offsetWidth;       // 애니메이션을 다시 시작하기 위한 트릭
        b.classList.add('pop');
      }
    });
  }

  /** 다른 기기 로그인 등으로 연결이 끊긴 경우 */
  async function handleUnlinked() {
    state.profile = null;
    localStorage.removeItem('vote_profile');
    renderAuth();
    renderCommentFormState();
  }

  // -------------------------------------------------------------------
  // 6. 댓글
  // -------------------------------------------------------------------

  async function submitComment(ev) {
    ev.preventDefault();
    const text = el.commentInput.value.trim();
    if (!text) return;
    if (text.length > 200) { toast('200자까지 쓸 수 있어요'); return; }
    if (!state.current) return;

    el.btnComment.disabled = true;
    const { data, error } = await sb.rpc('add_comment', { p_artwork_id: state.current.id, p_content: text });
    el.btnComment.disabled = false;

    if (error) {
      const msg = friendlyError(error);
      toast(msg, 3500);
      if (/로그인이 필요/.test(msg)) await handleUnlinked();
      return;
    }
    state.comments.push(data);
    el.commentInput.value = '';
    el.charCount.textContent = '0';
    renderComments();
    el.commentList.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function deleteComment(commentId) {
    if (!confirm('이 댓글을 삭제할까요?')) return;
    const { error } = await sb.rpc('delete_my_comment', { p_comment_id: commentId });
    if (error) { toast(friendlyError(error), 3500); return; }
    state.comments = state.comments.filter((c) => c.id !== commentId);
    renderComments();
  }

  // -------------------------------------------------------------------
  // 7. 로그인 / 로그아웃
  // -------------------------------------------------------------------

  async function submitLogin(ev) {
    ev.preventDefault();
    el.loginError.classList.add('hidden');

    const school = el.inSchool.value.trim();
    const studentNo = el.inStudentNo.value.trim();
    const name = el.inName.value.trim();
    const consent = el.inConsent.checked;

    if (!school || !studentNo || !name) { showLoginError('학교, 학번, 이름을 모두 입력해 주세요.'); return; }
    if (!consent) { showLoginError('개인정보 수집·이용에 동의해야 참여할 수 있어요.'); return; }

    el.btnLogin.disabled = true;
    el.btnLogin.textContent = '확인 중…';
    try {
      // 1) 세션이 없으면 익명 로그인 (있으면 그대로 재사용 → 횟수 제한 절약)
      const { data: { session } } = await sb.auth.getSession();
      if (!session) {
        const { error } = await sb.auth.signInAnonymously();
        if (error) throw error;
      }
      // 2) 학생 프로필 연결
      const { data, error } = await sb.rpc('claim_student', {
        p_school: school, p_student_no: studentNo, p_name: name, p_consent: consent,
      });
      if (error) throw error;

      state.profile = data;
      localStorage.setItem('vote_profile', JSON.stringify(data));
      closeModal(el.loginModal);
      el.loginForm.reset();
      renderAuth();
      renderCommentFormState();
      await refreshStats();          // 내가 눌렀던 하트 표시
      toast(`${data.name}님, 환영해요!`);
    } catch (err) {
      showLoginError(friendlyError(err));
    } finally {
      el.btnLogin.disabled = false;
      el.btnLogin.textContent = '참여하기';
    }
  }

  function showLoginError(msg) {
    el.loginError.textContent = msg;
    el.loginError.classList.remove('hidden');
  }

  async function logout() {
    if (!confirm('로그아웃할까요? 다시 로그인하면 투표 기록은 그대로 남아 있어요.')) return;
    await sb.auth.signOut();
    state.profile = null;
    localStorage.removeItem('vote_profile');
    renderAuth();
    renderCommentFormState();
    await refreshStats();
    toast('로그아웃했어요');
  }

  // -------------------------------------------------------------------
  // 8. 이벤트 연결
  // -------------------------------------------------------------------

  // 갤러리: 카드 안의 어떤 요소를 눌렀는지에 따라 분기 (이벤트 위임)
  el.gallery.addEventListener('click', (ev) => {
    const card = ev.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    if (ev.target.closest('[data-heart]')) { toggleLike(id); return; }
    if (ev.target.closest('[data-open]')) { openDetail(id); }
  });

  // 정렬 버튼
  document.querySelectorAll('.seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('is-active', x === b));
      state.sort = b.dataset.sort;
      renderGallery();
    });
  });

  // 상세 모달
  el.detailHeart.addEventListener('click', () => state.current && toggleLike(state.current.id));
  el.commentForm.addEventListener('submit', submitComment);
  el.commentInput.addEventListener('input', () => { el.charCount.textContent = el.commentInput.value.length; });
  el.commentList.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-del]');
    if (btn) deleteComment(btn.closest('.comment-item').dataset.cid);
  });
  document.querySelectorAll('[data-open-login]').forEach((b) => b.addEventListener('click', () => openModal(el.loginModal)));

  // 로그인 모달
  el.loginForm.addEventListener('submit', submitLogin);
  $('btnRetry').addEventListener('click', init);

  // 모달 닫기 (배경, X 버튼, ESC)
  document.querySelectorAll('.modal').forEach((m) => {
    m.querySelectorAll('[data-close]').forEach((c) => c.addEventListener('click', () => {
      closeModal(m);
      if (m === el.detailModal) state.current = null;
    }));
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    document.querySelectorAll('.modal:not(.hidden)').forEach((m) => closeModal(m));
    state.current = null;
  });

  // 다른 탭/앱 갔다 돌아오면 숫자와 투표 상태 새로고침
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.loaded) {
      safe(loadSettings).then(() => { renderGallery(); renderDetailHeart(); renderCommentFormState(); });
      refreshStats();
    }
  });
  // 60초마다 하트 수 갱신 (친구들 투표가 반영되도록)
  setInterval(refreshStats, 60 * 1000);

  /** 실패해도 화면이 멈추지 않게 감싸는 도우미 */
  async function safe(fn) { try { return await fn(); } catch (e) { console.warn(e); } }

  // -------------------------------------------------------------------
  // 9. 시작
  // -------------------------------------------------------------------
  async function init() {
    el.errorBox.classList.add('hidden');
    el.gallery.innerHTML = '<div class="card skeleton"></div>'.repeat(4);
    renderAuth();   // 불러오기에 실패해도 로그인 버튼은 동작해야 함
    try {
      await Promise.all([loadSettings(), restoreProfile()]);
      await loadArtworks();
      state.loaded = true;
      renderAuth();
      renderGallery();
    } catch (err) {
      console.error(err);
      el.gallery.innerHTML = '';
      el.errorText.textContent = '작품을 불러오지 못했어요. ' + friendlyError(err);
      el.errorBox.classList.remove('hidden');
    }
  }

  init();
})();
