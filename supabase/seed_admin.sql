-- =====================================================================
--  관리자(교사) 계정을 SQL 로 미리 만들기
-- =====================================================================
--  언제 쓰나요?
--    admin.html 의 "관리자 계정 만들기"(가입 코드 입력) 대신,
--    Supabase SQL Editor 에서 첫 관리자 계정을 바로 만들고 싶을 때 사용합니다.
--
--  사용 방법
--    1) 아래 두 줄의 값을 실제 이메일·비밀번호로 바꿉니다.
--    2) schema.sql 을 먼저 실행한 뒤, 이 파일 전체를 SQL Editor 에 붙여넣고 Run.
--    3) 같은 이메일이 이미 있으면 비밀번호를 새 값으로 바꾸고 관리자로 등록합니다.
--
--  주의
--    - 이 파일은 비밀번호가 들어 있으므로 GitHub 에 올리지 마세요 (.gitignore 에 포함).
--    - 비밀번호는 6자 이상 (Supabase 기본 규칙).
-- =====================================================================

do $$
declare
  v_email     text := 'teacher@example.com';   -- ← 관리자 이메일로 바꾸세요
  v_password  text := 'change-me-123';         -- ← 관리자 비밀번호로 바꾸세요
  v_uid       uuid;
begin
  v_email := lower(btrim(v_email));

  -- 1) 이미 같은 이메일 계정이 있는지 확인
  select id into v_uid from auth.users where lower(email) = v_email limit 1;

  if v_uid is null then
    -- 2) 없으면 auth.users 에 직접 생성 (이메일 인증 완료 상태)
    v_uid := gen_random_uuid();

    insert into auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
      extensions.crypt(v_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
      now(), now(),
      '', '', '', ''
    );

    -- 3) 이메일 로그인에 필요한 identity 행도 함께 생성
    insert into auth.identities (
      id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(), v_uid, v_uid::text, 'email',
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
      now(), now(), now()
    );
  else
    -- 이미 있으면 비밀번호 재설정 + 인증 완료 처리
    update auth.users
       set encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
           email_confirmed_at = coalesce(email_confirmed_at, now()),
           updated_at = now()
     where id = v_uid;
  end if;

  -- 4) 관리자 명단에 등록
  insert into public.admins (email) values (v_email)
  on conflict (email) do nothing;

  raise notice '관리자 계정 준비 완료: %', v_email;
end;
$$;
