# 학교 캐릭터 공모전 투표 사이트

학생들이 제출한 캐릭터 작품을 갤러리로 보여 주고, 학생이 로그인한 뒤 **하트(좋아요)와 댓글**로 투표하는 사이트입니다.
교사는 `admin.html`에서 작품 등록, 투표 시작/마감, 결과 집계를 합니다.

- 프론트: HTML + CSS + 바닐라 JS (빌드 도구 없음)
- 백엔드: Supabase (Database + Storage + Auth)
- 배포: GitHub Pages

## 폴더 구성

```
vote_app/
├── index.html         학생 화면 (갤러리·하트·댓글)
├── admin.html         교사(관리자) 화면
├── css/style.css      학생 화면 스타일
├── css/admin.css      관리자 화면 스타일
├── js/config.js       Supabase URL · anon key (여기만 수정하면 됨)
├── js/app.js          학생 화면 로직
├── js/admin.js        관리자 화면 로직
├── supabase/schema.sql      DB 테이블·함수·RLS·Storage 를 한 번에 만드는 SQL
├── supabase/seed_admin.sql  첫 관리자 계정을 SQL 로 만드는 파일 (GitHub 에 올리지 않음)
├── 작품정보.csv       작품 제목·출품자·설명·파일명키워드 (관리자 화면에서 불러오기)
└── README.md
```

---

## 1. Supabase 설정 (처음 한 번)

### 1-1. SQL 실행

1. [Supabase 대시보드](https://supabase.com/dashboard) → 프로젝트 **db_hyunuk** 선택
2. 왼쪽 메뉴 **SQL Editor** → **New query**
3. `supabase/schema.sql` 파일을 열어 내용 전체를 복사해 붙여넣고 **Run**
4. 맨 아래에 `Success. No rows returned` 가 보이면 성공입니다.
   (다시 실행해도 안전합니다. 테이블이 이미 있으면 그대로 두고 함수·정책만 새로 씁니다.)

이 SQL 이 만드는 것:

| 종류 | 이름 | 역할 |
|---|---|---|
| 테이블 | `settings` | 사이트 제목·안내문·투표 열림/닫힘 (1행) |
| 테이블 | `secrets` | 관리자 가입 코드 (기본값 `sonline`). API 로 읽을 수 없음 |
| 테이블 | `admins` | 관리자 이메일 목록 |
| 테이블 | `students` | 로그인한 학생 (학교·학번·이름·연결된 기기) |
| 테이블 | `artworks` / `likes` / `comments` | 작품 / 하트 / 댓글 |
| 함수 | `claim_student`, `toggle_like`, `add_comment`, `delete_my_comment` | 학생이 쓰기를 할 수 있는 유일한 통로 |
| 함수 | `activate_admin_account` | 가입 코드를 확인하고 관리자 등록 |
| Storage | `artworks` 버킷 | 작품 이미지 (공개 읽기, 관리자만 업로드) |

### 1-2. 인증 설정 (대시보드에서 직접)

1. **Authentication → Sign In / Providers**
   - **Anonymous sign-ins** 를 켭니다. (학생 로그인은 내부적으로 익명 로그인을 사용)
   - **Email** 공급자는 켜져 있는지 확인합니다. (교사 로그인용)
2. **Authentication → Rate Limits**
   - *Anonymous sign-ins* 기본값은 IP 당 시간당 30회입니다. 학교에서는 많은 학생이 같은 공인 IP 를 쓰므로
     **학생 수보다 넉넉하게**(예: 500) 올립니다.
3. **Authentication → Email** (권장)
   - **Confirm email** 을 끕니다. 켜 둬도 `activate_admin_account` 함수가 인증을 완료 처리하지만, 꺼 두면 더 단순합니다.

### 1-3. 관리자 가입 코드 바꾸기 (권장)

기본값 `sonline` 은 이 저장소에 적혀 있으니 바꿔 두세요. SQL Editor 에서:

```sql
update public.secrets set value = '새로운코드' where key = 'admin_signup_code';
```

### 1-4. 첫 관리자 계정 만들기 (둘 중 하나)

**방법 A. 관리자 화면에서 (쉬움)**
`admin.html` → **관리자 계정 만들기** 탭 → 이메일·비밀번호·가입 코드 입력 → 바로 로그인됩니다.

**방법 B. SQL 로 미리 만들기**
`supabase/seed_admin.sql` 을 열어 이메일과 비밀번호 두 줄을 바꾼 뒤 SQL Editor 에서 실행합니다.
이 파일은 비밀번호가 들어 있으므로 `.gitignore` 에 넣어 두었습니다. GitHub 에 올리지 마세요.

### 1-5. 키 확인

`js/config.js` 에 **Project URL** 과 **anon (publishable) key** 가 들어 있습니다.
다른 프로젝트를 쓰려면 **Project Settings → API** 에서 값을 복사해 바꿉니다.

> anon key 는 공개용 키라 코드에 넣어도 됩니다. **service_role / secret key 는 절대 넣지 마세요.**

---

## 2. 로컬에서 테스트

브라우저가 `file://` 로 연 페이지에서는 Supabase 로그인 저장이 제대로 안 될 수 있으니, 간단한 로컬 서버로 엽니다.

파이썬이 있으면:

```bash
python -m http.server 8000
```

VS Code 라면 **Live Server** 확장을 써도 됩니다.
그다음 브라우저에서 `http://localhost:8000/index.html` (학생), `http://localhost:8000/admin.html` (관리자) 를 엽니다.

**점검 순서**

1. `admin.html` 로그인 → 대시보드 숫자가 보이면 DB 연결 성공
2. **작품** 탭에서 이미지를 올리고, 학생 화면에 보이는지 확인
3. 대시보드에서 **투표 시작** 켜기
4. `index.html` 에서 로그인(학교·학번·이름) → 하트·댓글 눌러 보기
5. 다른 브라우저(또는 시크릿 창)에서 같은 학번·다른 이름으로 로그인 → 거부되는지 확인
6. 같은 학번·같은 이름으로 로그인 → 처음 브라우저에서 하트를 누르면 "다시 로그인" 안내가 나오는지 확인

---

## 3. GitHub Pages 배포

1. GitHub 에 새 저장소를 만듭니다 (예: `vote-app`). **Public** 이어야 무료 Pages 를 쓸 수 있습니다.
2. 이 폴더의 파일을 올립니다. 처음이라면:

```bash
git init
git add .
git commit -m "캐릭터 공모전 투표 사이트"
git branch -M main
git remote add origin https://github.com/<아이디>/<저장소>.git
git push -u origin main
```

3. 저장소 **Settings → Pages** → *Build and deployment* 에서
   **Source: Deploy from a branch**, **Branch: main / (root)** 선택 → Save
4. 1~2분 뒤 `https://<아이디>.github.io/<저장소>/` 로 접속됩니다.
   관리자 화면은 `https://<아이디>.github.io/<저장소>/admin.html`

> `seed_admin.sql` 은 `.gitignore` 에 있어 올라가지 않습니다. 올리기 전에 `git status` 로 한 번 확인하세요.

학생들에게는 QR 코드나 짧은 링크로 주소를 공유하면 편합니다.

---

## 4. 운영 방법

### 작품 등록 (관리자 → 작품 탭)

1. `작품정보.csv` 를 엑셀/스프레드시트로 열어 제목·출품자·설명·파일명키워드를 채웁니다.
   - **파일명키워드**: 이미지 파일 이름에 들어 있는 글자. 예) 파일이 `03_고양이.png` 면 키워드 `03`
   - 엑셀에서 저장할 때 **CSV UTF-8** 을 고르면 한글이 깨지지 않습니다. (일반 CSV 로 저장해도 자동 인식합니다)
2. **작품 정보 CSV 불러오기** 로 CSV 를 선택
3. 이미지를 점선 상자에 끌어다 놓기 (여러 장 가능). 키워드가 맞으면 제목·출품자·설명이 자동으로 채워집니다.
   안 맞으면 각 이미지 옆의 드롭다운에서 고르거나 직접 입력합니다.
4. **모두 업로드**
5. 아래 목록에서 제목 등을 바로 고치고 **저장**, 필요하면 **숨기기 / 삭제**

### 투표 진행

- 대시보드의 **투표 상태** 스위치를 켜면 학생이 하트·댓글을 쓸 수 있습니다.
- 끄면 학생은 보기만 할 수 있고, 하트·댓글 자리에 "투표가 마감되었습니다"가 표시됩니다.
- 안내문에 투표 기간을 적어 두면 좋습니다. (줄바꿈 가능)

### 학생 관리 (학생 탭)

- 로그인한 학생 목록, 검색, CSV 내려받기
- **기기 해제**: 그 학생이 다시 로그인해야 투표할 수 있게 함 (휴대폰을 바꿨거나 문제가 있을 때)
- **삭제**: 프로필과 하트·댓글을 모두 삭제

### 댓글 관리 (댓글 탭)

- 실제 이름·학번·작품과 함께 모든 댓글을 봅니다. (학생 화면에는 `강*욱` 처럼 마스킹된 이름만 보입니다)
- 부적절한 댓글은 **숨기기** (학생 화면에서만 사라짐) 또는 **삭제**

### 결과 (결과 탭)

- 하트 수 순위표. 동점은 같은 순위.
- CSV 3종: **작품별 집계**, **하트 상세**(누가 어느 작품에 언제), **댓글 상세**. 엑셀에서 바로 열립니다.

### 교사 계정 (교사 계정 탭)

- 다른 선생님 추가: 이메일·비밀번호·가입 코드 입력 (로그인 화면의 "관리자 계정 만들기"와 같은 방식)
- **권한 해제**: 관리자 목록에서 제거 (본인은 해제할 수 없음)

### 공모전이 끝나면

개인정보 동의 문구대로 학생 정보를 삭제합니다. SQL Editor 에서:

```sql
delete from public.students;   -- 하트·댓글도 함께 삭제됨
```

---

## 5. 동작 원리 요약 (학생·동료 교사에게 설명할 때)

- **학생 로그인** = Supabase 익명 로그인 + `claim_student` 함수. 학교·학번·이름으로 프로필을 찾고, 없으면 만듭니다.
  - 학교 이름은 띄어쓰기와 "등학교/학교" 꼬리를 무시하고 비교합니다. (`서울 고등학교` = `서울고`)
  - 같은 학교·학번에 **다른 이름**으로 들어오면 거부합니다.
  - 같은 사람이 다른 기기에서 로그인하면 연결이 새 기기로 넘어가고, 이전 기기는 투표할 수 없습니다.
- **하트/댓글**은 전부 DB 함수(`toggle_like`, `add_comment`, `delete_my_comment`)를 통해서만 저장됩니다.
  함수 안에서 투표 기간, 본인 여부, 글자 수를 다시 검사하므로 브라우저 쪽 코드를 바꿔도 우회할 수 없습니다.
- **관리자**는 `admins` 표에 이메일이 있고 익명 계정이 아닌 사용자입니다. 모든 표의 RLS 정책이 `is_admin()` 으로 판단합니다.
- **댓글 작성자 이름**은 저장할 때 이미 마스킹되어 있어, 실제 이름이 다른 학생에게 전달될 경로가 없습니다.

---

## 6. 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| 학생 로그인 시 "Anonymous sign-ins are disabled" | Authentication → Sign In / Providers 에서 **Anonymous sign-ins** 켜기 |
| 로그인이 한참 되다가 "잠시 후 다시 시도" | 익명 로그인 **Rate Limit** 초과. Authentication → Rate Limits 에서 올리기 |
| 작품을 불러오지 못해요 | `js/config.js` 의 URL·key 확인, `schema.sql` 이 실행됐는지 확인. 브라우저 F12 → Console 의 빨간 메시지 참고 |
| 관리자 로그인은 되는데 "관리자로 등록되어 있지 않습니다" | `admins` 표에 이메일이 없음. "관리자 계정 만들기"에서 가입 코드로 등록하거나 SQL 로 `insert into public.admins(email) values ('이메일');` |
| "관리자 가입 코드가 올바르지 않습니다" | `secrets` 표의 `admin_signup_code` 값과 다름. SQL Editor 에서 `select * from public.secrets;` 로 확인 |
| 이미지 업로드 실패 (403, new row violates row-level security) | 관리자가 아니거나 Storage 정책이 없음. `schema.sql` 다시 실행 |
| 이미지 업로드 실패 (mime type / file size) | 이미지 파일(JPG·PNG·WebP·GIF)만, 10MB 이하 |
| 학생이 하트를 눌렀는데 "로그인이 필요합니다" | 다른 기기에서 같은 학번으로 로그인해서 연결이 넘어감. 다시 로그인하면 됨 |
| 엑셀에서 CSV 한글이 깨짐 | 내려받은 CSV 는 BOM 이 포함돼 있어 더블클릭으로 열면 정상. 그래도 깨지면 엑셀 **데이터 → 텍스트/CSV 가져오기**에서 UTF-8 선택 |
| GitHub Pages 주소에서 404 | Settings → Pages 에서 Branch 가 `main / (root)` 인지, `index.html` 이 저장소 루트에 있는지 확인 |
| 수정한 내용이 사이트에 안 보임 | GitHub Pages 반영까지 1~2분. 브라우저 캐시는 Ctrl+F5 로 새로고침 |

### 가입 코드·관리자 관련 SQL 모음

```sql
-- 관리자 목록 보기
select * from public.admins;

-- 관리자 직접 추가 (계정은 이미 있어야 함)
insert into public.admins (email) values ('teacher@school.kr') on conflict do nothing;

-- 가입 코드 바꾸기
update public.secrets set value = '새코드' where key = 'admin_signup_code';

-- 투표 강제로 열기/닫기
update public.settings set voting_open = true where id = 1;
```
