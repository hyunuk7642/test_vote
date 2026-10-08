-- =====================================================================
--  학교 캐릭터 공모전 투표 사이트 - Supabase 스키마
-- =====================================================================
--  사용 방법
--    1) Supabase 대시보드 → SQL Editor → New query
--    2) 이 파일 전체를 붙여넣고 Run
--    3) 다시 실행해도 안전합니다 (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS 사용)
--
--  구성
--    [1] 확장 기능
--    [2] 테이블 (settings, secrets, admins, students, artworks, likes, comments)
--    [3] 공용 함수 (학교명 정규화, 이름 마스킹, 관리자 판정)
--    [4] 학생용 함수 (claim_student, toggle_like, add_comment, delete_my_comment, 조회 함수)
--    [5] 관리자용 함수 (activate_admin_account)
--    [6] RLS(행 수준 보안) 정책
--    [7] Storage 버킷 + 정책
--    [8] 권한(GRANT/REVOKE) 정리
--
--  보안 원칙
--    - 학생은 테이블에 직접 INSERT/UPDATE/DELETE 할 수 없습니다.
--      쓰기는 전부 SECURITY DEFINER 함수(함수 소유자 권한으로 실행)를 통해서만 이루어지고,
--      함수 안에서 투표 기간·본인 여부·글자 수를 다시 검사합니다.
--    - 관리자 판정은 is_admin() 하나로 통일합니다.
--      (admins 표에 이메일이 있고 + 익명 로그인 계정이 아닐 것)
--    - secrets 표는 누구도 API로 읽을 수 없습니다 (RLS 켜고 정책 없음 + GRANT 회수).
-- =====================================================================


-- =====================================================================
-- [1] 확장 기능
-- =====================================================================
-- gen_random_uuid() 는 pgcrypto 확장에 들어 있습니다. Supabase에는 기본 설치되어 있지만
-- 혹시 몰라 한 번 더 선언합니다.
create extension if not exists pgcrypto with schema extensions;


-- =====================================================================
-- [2] 테이블
-- =====================================================================

-- ---------------------------------------------------------------------
-- settings : 사이트 설정 (딱 1행만 존재, id = 1)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id            int primary key default 1 check (id = 1),  -- 항상 1 (단일 행 강제)
  site_title    text not null default '학교 캐릭터 공모전 투표',
  notice        text not null default '마음에 드는 캐릭터에 하트를 눌러 주세요!',
  voting_open   boolean not null default false,            -- true = 투표 진행 중
  updated_at    timestamptz not null default now()
);

-- 기본 행이 없으면 만들어 둡니다 (이미 있으면 그대로 둠)
insert into public.settings (id) values (1) on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- secrets : 서버에서만 읽는 비밀 값 (관리자 가입 코드 등)
--   * 클라이언트(anon/authenticated)는 절대 읽을 수 없습니다.
--   * 값 변경은 SQL Editor에서 직접:
--       update public.secrets set value = '새코드' where key = 'admin_signup_code';
-- ---------------------------------------------------------------------
create table if not exists public.secrets (
  key    text primary key,
  value  text not null
);

insert into public.secrets (key, value)
values ('admin_signup_code', 'sonline')
on conflict (key) do nothing;   -- 이미 바꿔 둔 값이 있으면 덮어쓰지 않음


-- ---------------------------------------------------------------------
-- admins : 관리자(교사) 이메일 목록
--   * 이 표에 이메일이 있어야 admin.html 기능을 쓸 수 있습니다.
--   * 추가는 activate_admin_account() 함수(가입 코드 검증)로만 가능합니다.
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  email       text primary key,          -- 소문자로 저장
  created_at  timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- students : 로그인한 학생 프로필
--   * 같은 (정규화한 학교, 학번)은 프로필이 1개만 생깁니다 (unique 인덱스).
--   * user_id = 현재 이 프로필에 연결된 Supabase 익명 계정.
--     다른 기기에서 다시 로그인하면 user_id가 새 계정으로 바뀌어
--     이전 기기는 자동으로 투표 권한을 잃습니다.
-- ---------------------------------------------------------------------
create table if not exists public.students (
  id             uuid primary key default gen_random_uuid(),
  school         text not null,                 -- 학생이 입력한 학교명 그대로
  school_norm    text not null,                 -- 비교용 정규화 학교명 (normalize_school)
  student_no     text not null,                 -- 학번 (문자열로 저장: 앞자리 0 보존)
  name           text not null,                 -- 실제 이름 (관리자만 열람)
  user_id        uuid unique references auth.users (id) on delete set null,  -- 연결된 익명 계정
  consent_at     timestamptz not null default now(),  -- 개인정보 동의 시각
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz not null default now()
);

-- 같은 학교·학번 중복 방지 (투표 1인 1회의 핵심)
create unique index if not exists students_school_no_uniq
  on public.students (school_norm, student_no);


-- ---------------------------------------------------------------------
-- artworks : 출품작
-- ---------------------------------------------------------------------
create table if not exists public.artworks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null default '',
  author       text not null default '',       -- 출품자 (학생 이름/팀명)
  description  text not null default '',
  image_path   text not null,                  -- Storage 버킷 안의 경로 (예: 2026/abc.png)
  sort_order   int  not null default 0,        -- 관리자 정렬용 (최신순은 created_at 사용)
  hidden       boolean not null default false, -- true = 갤러리에서 숨김
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- likes : 하트 (작품당 학생 1명 1개)
-- ---------------------------------------------------------------------
create table if not exists public.likes (
  id          uuid primary key default gen_random_uuid(),
  artwork_id  uuid not null references public.artworks (id) on delete cascade,
  student_id  uuid not null references public.students (id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (artwork_id, student_id)             -- 중복 하트 차단
);

create index if not exists likes_artwork_idx on public.likes (artwork_id);
create index if not exists likes_student_idx on public.likes (student_id);


-- ---------------------------------------------------------------------
-- comments : 댓글
--   * masked_name 은 저장 시점에 마스킹된 이름(예: 강*욱)이고,
--     학생 화면에는 이 값만 내려갑니다. 실제 이름은 students 표에만 있습니다.
-- ---------------------------------------------------------------------
create table if not exists public.comments (
  id           uuid primary key default gen_random_uuid(),
  artwork_id   uuid not null references public.artworks (id) on delete cascade,
  student_id   uuid not null references public.students (id) on delete cascade,
  masked_name  text not null,
  content      text not null check (char_length(content) between 1 and 200),
  hidden       boolean not null default false,  -- 관리자가 숨긴 댓글
  created_at   timestamptz not null default now()
);

create index if not exists comments_artwork_idx on public.comments (artwork_id, created_at);
create index if not exists comments_student_idx on public.comments (student_id);


-- =====================================================================
-- [3] 공용 함수
-- =====================================================================

-- ---------------------------------------------------------------------
-- normalize_school(학교명) → 비교용 문자열
--   규칙: 공백 제거 → 소문자 → 꼬리의 '등학교' 또는 '학교' 제거
--   예) '서울 고등학교' → '서울고',  '서울고' → '서울고',
--       '한빛중학교'   → '한빛중',  '한빛중' → '한빛중'
-- ---------------------------------------------------------------------
create or replace function public.normalize_school(p_school text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           lower(regexp_replace(coalesce(p_school, ''), '\s+', '', 'g')),  -- 공백 제거 + 소문자
           '(등학교|학교)$', ''                                               -- 꼬리 제거
         );
$$;


-- ---------------------------------------------------------------------
-- mask_name(이름) → 마스킹된 이름
--   1글자: *      2글자: 강*     3글자: 강*욱     4글자 이상: 남**궁 (가운데 전부 *)
-- ---------------------------------------------------------------------
create or replace function public.mask_name(p_name text)
returns text
language plpgsql
immutable
as $$
declare
  v_name text := regexp_replace(coalesce(p_name, ''), '\s+', '', 'g');  -- 공백 제거
  v_len  int  := char_length(v_name);
begin
  if v_len <= 1 then
    return '*';
  elsif v_len = 2 then
    return substr(v_name, 1, 1) || '*';
  else
    return substr(v_name, 1, 1) || repeat('*', v_len - 2) || substr(v_name, v_len, 1);
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- is_admin() → 현재 로그인한 사용자가 관리자인가?
--   조건 1) 익명 로그인 계정이 아닐 것 (JWT의 is_anonymous = false)
--   조건 2) JWT의 email 이 admins 표에 있을 것
--   * SECURITY DEFINER 로 만들어 admins 표의 RLS에 막히지 않고 조회합니다.
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and exists (
      select 1 from public.admins
      where email = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;


-- ---------------------------------------------------------------------
-- voting_is_open() → 현재 투표 진행 중인가?
-- ---------------------------------------------------------------------
create or replace function public.voting_is_open()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select voting_open from public.settings where id = 1), false);
$$;


-- ---------------------------------------------------------------------
-- current_student_id() → 현재 로그인(익명 계정)에 연결된 학생 프로필 id
--   연결된 프로필이 없으면 NULL (= 로그인 안 했거나, 다른 기기로 연결이 넘어감)
-- ---------------------------------------------------------------------
create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.students where user_id = auth.uid() limit 1;
$$;


-- =====================================================================
-- [4] 학생용 함수
--   모든 함수는 SECURITY DEFINER + search_path 고정.
--   클라이언트는 supabase.rpc('함수명', {...}) 로 호출합니다.
--   오류는 raise exception 으로 던지며, 메시지가 그대로 화면에 표시됩니다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- claim_student(학교, 학번, 이름, 동의여부)
--   익명 로그인 직후 호출해서 학생 프로필을 만들거나(없으면) 이 기기에 연결합니다.
--   - 같은 (정규화 학교, 학번)이 이미 있고 이름이 다르면 → 거부 (학번 도용 방지)
--   - 같은 사람이 다시 로그인하면 → user_id 를 이 기기 계정으로 교체 (이전 기기 투표 불가)
--   반환: 학생 프로필 요약 (id, school, student_no, name)
-- ---------------------------------------------------------------------
create or replace function public.claim_student(
  p_school      text,
  p_student_no  text,
  p_name        text,
  p_consent     boolean
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_school      text := btrim(coalesce(p_school, ''));
  v_school_norm text;
  v_no          text := regexp_replace(coalesce(p_student_no, ''), '\s+', '', 'g');
  v_name        text := btrim(coalesce(p_name, ''));
  v_row         public.students%rowtype;
begin
  -- 0) 기본 검사 --------------------------------------------------------
  if v_uid is null then
    raise exception '로그인 정보가 없습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.';
  end if;
  if coalesce(p_consent, false) = false then
    raise exception '개인정보 수집·이용에 동의해야 참여할 수 있습니다.';
  end if;
  if v_school = '' or v_no = '' or v_name = '' then
    raise exception '학교, 학번, 이름을 모두 입력해 주세요.';
  end if;
  if char_length(v_school) > 50 or char_length(v_no) > 20 or char_length(v_name) > 30 then
    raise exception '입력값이 너무 깁니다.';
  end if;

  v_school_norm := public.normalize_school(v_school);
  if v_school_norm = '' then
    raise exception '학교 이름을 정확히 입력해 주세요.';
  end if;

  -- 1) 같은 학교·학번 프로필이 있는지 확인 -------------------------------
  select * into v_row
  from public.students
  where school_norm = v_school_norm and student_no = v_no
  for update;   -- 동시에 두 기기에서 로그인해도 한 줄씩 처리되도록 잠금

  if found then
    -- 이름 비교: 공백을 뺀 뒤 완전히 같아야 함
    if regexp_replace(v_row.name, '\s+', '', 'g') <> regexp_replace(v_name, '\s+', '', 'g') then
      raise exception '이미 다른 이름으로 등록된 학번입니다. 학교·학번·이름을 다시 확인해 주세요.';
    end if;

    -- 같은 사람 → 이 기기(익명 계정)로 연결을 옮김
    update public.students
       set user_id       = v_uid,
           school        = v_school,     -- 표기(띄어쓰기 등)는 최근 입력으로 갱신
           last_login_at = now()
     where id = v_row.id
     returning * into v_row;
  else
    -- 2) 새 프로필 생성 --------------------------------------------------
    -- 혹시 이 익명 계정이 다른 프로필에 연결돼 있었다면 끊어 줌 (user_id unique 보호)
    update public.students set user_id = null where user_id = v_uid;

    insert into public.students (school, school_norm, student_no, name, user_id, consent_at)
    values (v_school, v_school_norm, v_no, v_name, v_uid, now())
    returning * into v_row;
  end if;

  return json_build_object(
    'id',         v_row.id,
    'school',     v_row.school,
    'student_no', v_row.student_no,
    'name',       v_row.name
  );
end;
$$;


-- ---------------------------------------------------------------------
-- toggle_like(작품 id)
--   하트가 없으면 추가, 있으면 취소.
--   반환: { liked: true/false, count: 현재 하트 수 }
-- ---------------------------------------------------------------------
create or replace function public.toggle_like(p_artwork_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student uuid := public.current_student_id();
  v_liked   boolean;
  v_count   int;
begin
  if not public.voting_is_open() then
    raise exception '지금은 투표 기간이 아닙니다.';
  end if;
  if v_student is null then
    raise exception '로그인이 필요합니다. (다른 기기에서 로그인했다면 이 기기에서는 투표할 수 없어요)';
  end if;
  if not exists (select 1 from public.artworks where id = p_artwork_id and hidden = false) then
    raise exception '존재하지 않거나 숨겨진 작품입니다.';
  end if;

  -- 있으면 삭제, 없으면 추가
  delete from public.likes where artwork_id = p_artwork_id and student_id = v_student;
  if found then
    v_liked := false;
  else
    insert into public.likes (artwork_id, student_id) values (p_artwork_id, v_student);
    v_liked := true;
  end if;

  select count(*) into v_count from public.likes where artwork_id = p_artwork_id;
  return json_build_object('liked', v_liked, 'count', v_count);
end;
$$;


-- ---------------------------------------------------------------------
-- add_comment(작품 id, 내용)
--   200자 제한, 작성자명은 저장 시점에 마스킹.
--   반환: 방금 저장한 댓글 (id, artwork_id, masked_name, content, created_at, is_mine)
-- ---------------------------------------------------------------------
create or replace function public.add_comment(p_artwork_id uuid, p_content text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student  uuid := public.current_student_id();
  v_content  text := btrim(coalesce(p_content, ''));
  v_name     text;
  v_row      public.comments%rowtype;
begin
  if not public.voting_is_open() then
    raise exception '지금은 투표 기간이 아닙니다.';
  end if;
  if v_student is null then
    raise exception '로그인이 필요합니다. (다른 기기에서 로그인했다면 이 기기에서는 댓글을 쓸 수 없어요)';
  end if;
  if v_content = '' then
    raise exception '댓글 내용을 입력해 주세요.';
  end if;
  if char_length(v_content) > 200 then
    raise exception '댓글은 200자까지 쓸 수 있습니다.';
  end if;
  if not exists (select 1 from public.artworks where id = p_artwork_id and hidden = false) then
    raise exception '존재하지 않거나 숨겨진 작품입니다.';
  end if;

  select name into v_name from public.students where id = v_student;

  insert into public.comments (artwork_id, student_id, masked_name, content)
  values (p_artwork_id, v_student, public.mask_name(v_name), v_content)
  returning * into v_row;

  return json_build_object(
    'id',          v_row.id,
    'artwork_id',  v_row.artwork_id,
    'masked_name', v_row.masked_name,
    'content',     v_row.content,
    'created_at',  v_row.created_at,
    'is_mine',     true
  );
end;
$$;


-- ---------------------------------------------------------------------
-- delete_my_comment(댓글 id)
--   본인 댓글만 삭제. 반환: 삭제 여부(true/false)
-- ---------------------------------------------------------------------
create or replace function public.delete_my_comment(p_comment_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student uuid := public.current_student_id();
begin
  if not public.voting_is_open() then
    raise exception '지금은 투표 기간이 아닙니다.';
  end if;
  if v_student is null then
    raise exception '로그인이 필요합니다.';
  end if;

  delete from public.comments
   where id = p_comment_id and student_id = v_student;   -- 본인 것만

  if not found then
    raise exception '삭제할 수 있는 댓글이 아닙니다.';
  end if;
  return true;
end;
$$;


-- ---------------------------------------------------------------------
-- get_artwork_stats()
--   갤러리용 집계: 작품별 하트 수, 댓글 수, 내가 하트를 눌렀는지.
--   로그인 전(anon)에도 호출 가능 → liked_by_me 는 false.
--   (likes 표 자체는 학생이 읽을 수 없고, 개수는 이 함수로만 제공)
-- ---------------------------------------------------------------------
create or replace function public.get_artwork_stats()
returns table (
  artwork_id     uuid,
  like_count     bigint,
  comment_count  bigint,
  liked_by_me    boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select public.current_student_id() as sid)
  select
    a.id,
    (select count(*) from public.likes    l where l.artwork_id = a.id),
    (select count(*) from public.comments c where c.artwork_id = a.id and c.hidden = false),
    exists (select 1 from public.likes l, me where l.artwork_id = a.id and l.student_id = me.sid)
  from public.artworks a
  where a.hidden = false;
$$;


-- ---------------------------------------------------------------------
-- get_comments(작품 id)
--   학생 화면용 댓글 목록 (숨긴 댓글 제외, 마스킹된 이름만, 내 댓글 표시)
-- ---------------------------------------------------------------------
create or replace function public.get_comments(p_artwork_id uuid)
returns table (
  id           uuid,
  artwork_id   uuid,
  masked_name  text,
  content      text,
  created_at   timestamptz,
  is_mine      boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id, c.artwork_id, c.masked_name, c.content, c.created_at,
    (c.student_id = public.current_student_id()) as is_mine
  from public.comments c
  where c.artwork_id = p_artwork_id and c.hidden = false
  order by c.created_at asc;
$$;


-- ---------------------------------------------------------------------
-- get_my_profile()
--   이 기기에 연결된 학생 프로필 (없으면 null). 페이지를 다시 열 때 로그인 복원용.
-- ---------------------------------------------------------------------
create or replace function public.get_my_profile()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
           'id', s.id, 'school', s.school, 'student_no', s.student_no, 'name', s.name
         )
  from public.students s
  where s.user_id = auth.uid()
  limit 1;
$$;


-- =====================================================================
-- [5] 관리자용 함수
-- =====================================================================

-- ---------------------------------------------------------------------
-- activate_admin_account(이메일, 가입 코드)
--   admin.html 의 "관리자 계정 만들기"에서 호출.
--   순서: 클라이언트가 supabase.auth.signUp(이메일, 비밀번호) → 이 함수 호출
--   하는 일:
--     1) 가입 코드가 secrets.admin_signup_code 와 같은지 확인
--     2) 해당 이메일 계정의 이메일 인증을 완료 처리 (Confirm email 이 켜져 있어도 통과)
--     3) admins 표에 이메일 등록
--   * 로그인 세션 없이(anon) 호출할 수 있지만, 가입 코드를 알아야만 동작합니다.
--   * 비밀번호는 Supabase Auth가 관리하므로 이 함수는 비밀번호를 다루지 않습니다.
-- ---------------------------------------------------------------------
create or replace function public.activate_admin_account(p_email text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_secret text;
  v_uid    uuid;
begin
  select value into v_secret from public.secrets where key = 'admin_signup_code';

  if v_secret is null or btrim(coalesce(p_code, '')) <> v_secret then
    raise exception '관리자 가입 코드가 올바르지 않습니다.';
  end if;

  select id into v_uid from auth.users where lower(email) = v_email limit 1;
  if v_uid is null then
    raise exception '해당 이메일로 만들어진 계정이 없습니다. 먼저 계정을 생성해 주세요.';
  end if;

  -- 이메일 인증 완료 처리 (이미 돼 있으면 그대로)
  update auth.users
     set email_confirmed_at = coalesce(email_confirmed_at, now())
   where id = v_uid;

  insert into public.admins (email) values (v_email)
  on conflict (email) do nothing;

  return true;
end;
$$;


-- =====================================================================
-- [6] RLS 정책
--   모든 표에 RLS 를 켜고, 필요한 최소한의 정책만 둡니다.
--   정책이 없는 동작(예: 학생의 INSERT)은 자동으로 거부됩니다.
-- =====================================================================

alter table public.settings  enable row level security;
alter table public.secrets   enable row level security;
alter table public.admins    enable row level security;
alter table public.students  enable row level security;
alter table public.artworks  enable row level security;
alter table public.likes     enable row level security;
alter table public.comments  enable row level security;

-- ---- settings : 누구나 읽기, 관리자만 수정 --------------------------
drop policy if exists "settings_read_all"   on public.settings;
drop policy if exists "settings_admin_write" on public.settings;
create policy "settings_read_all" on public.settings
  for select to anon, authenticated using (true);
create policy "settings_admin_write" on public.settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---- secrets : 정책 없음 = 아무도 API로 접근 불가 ------------------
--      (함수 activate_admin_account 가 SECURITY DEFINER 로만 읽음)

-- ---- admins : 관리자만 목록 조회 / 본인이 아닌 관리자 삭제 ------------
--      INSERT 정책은 일부러 두지 않습니다 → activate_admin_account 로만 등록
drop policy if exists "admins_admin_read"   on public.admins;
drop policy if exists "admins_admin_delete" on public.admins;
create policy "admins_admin_read" on public.admins
  for select to authenticated using (public.is_admin());
create policy "admins_admin_delete" on public.admins
  for delete to authenticated
  using (public.is_admin() and email <> lower(coalesce(auth.jwt() ->> 'email', '')));

-- ---- students : 학생은 본인 프로필만 읽기, 관리자는 전부 ---------------
drop policy if exists "students_self_read"  on public.students;
drop policy if exists "students_admin_all"  on public.students;
create policy "students_self_read" on public.students
  for select to authenticated using (user_id = auth.uid());
create policy "students_admin_all" on public.students
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---- artworks : 숨기지 않은 작품은 누구나 읽기, 관리자는 전부 ----------
drop policy if exists "artworks_read_visible" on public.artworks;
drop policy if exists "artworks_admin_all"    on public.artworks;
create policy "artworks_read_visible" on public.artworks
  for select to anon, authenticated using (hidden = false);
create policy "artworks_admin_all" on public.artworks
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---- likes : 관리자만 직접 접근 (학생은 toggle_like / get_artwork_stats 로만) ----
drop policy if exists "likes_admin_all" on public.likes;
create policy "likes_admin_all" on public.likes
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---- comments : 관리자만 직접 접근 (학생은 add_comment / get_comments 로만) ----
drop policy if exists "comments_admin_all" on public.comments;
create policy "comments_admin_all" on public.comments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());


-- =====================================================================
-- [7] Storage 버킷 'artworks'
--   - 공개 버킷: 이미지 URL 을 누구나 볼 수 있음 (갤러리는 로그인 전에도 열람 가능)
--   - 업로드/수정/삭제는 관리자만
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'artworks', 'artworks', true,
  10485760,                                                     -- 10MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "artworks_public_read"   on storage.objects;
drop policy if exists "artworks_admin_insert"  on storage.objects;
drop policy if exists "artworks_admin_update"  on storage.objects;
drop policy if exists "artworks_admin_delete"  on storage.objects;

create policy "artworks_public_read" on storage.objects
  for select to anon, authenticated using (bucket_id = 'artworks');
create policy "artworks_admin_insert" on storage.objects
  for insert to authenticated with check (bucket_id = 'artworks' and public.is_admin());
create policy "artworks_admin_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'artworks' and public.is_admin())
  with check (bucket_id = 'artworks' and public.is_admin());
create policy "artworks_admin_delete" on storage.objects
  for delete to authenticated using (bucket_id = 'artworks' and public.is_admin());


-- =====================================================================
-- [8] 권한 정리
--   Supabase 는 public 스키마의 새 표/함수에 anon·authenticated 권한을 자동으로 줍니다.
--   그래서 "주면 안 되는 것"을 명시적으로 회수합니다.
-- =====================================================================

-- secrets 표: API 역할에서 모든 권한 회수 (RLS 와 이중 잠금)
revoke all on table public.secrets from anon, authenticated;

-- 학생 쓰기 함수는 로그인(authenticated)한 경우에만 호출 가능
revoke execute on function public.claim_student(text, text, text, boolean) from public, anon;
revoke execute on function public.toggle_like(uuid)                        from public, anon;
revoke execute on function public.add_comment(uuid, text)                  from public, anon;
revoke execute on function public.delete_my_comment(uuid)                  from public, anon;
grant  execute on function public.claim_student(text, text, text, boolean) to authenticated;
grant  execute on function public.toggle_like(uuid)                        to authenticated;
grant  execute on function public.add_comment(uuid, text)                  to authenticated;
grant  execute on function public.delete_my_comment(uuid)                  to authenticated;

-- 조회 함수는 로그인 전에도 호출 가능 (갤러리 열람)
grant execute on function public.get_artwork_stats()        to anon, authenticated;
grant execute on function public.get_comments(uuid)         to anon, authenticated;
grant execute on function public.get_my_profile()           to anon, authenticated;
grant execute on function public.is_admin()                 to anon, authenticated;
grant execute on function public.voting_is_open()           to anon, authenticated;
grant execute on function public.activate_admin_account(text, text) to anon, authenticated;

-- 내부 보조 함수는 클라이언트가 직접 부를 필요가 없음
revoke execute on function public.current_student_id() from public, anon, authenticated;
revoke execute on function public.normalize_school(text) from public, anon, authenticated;
revoke execute on function public.mask_name(text)        from public, anon, authenticated;

-- =====================================================================
-- 끝. 다음 단계:
--   Authentication → Sign In / Providers → Anonymous sign-ins 켜기
--   Authentication → Rate Limits → 익명 로그인 제한 올리기
--   (권장) Authentication → Email → Confirm email 끄기
-- =====================================================================
