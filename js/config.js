// =====================================================================
//  Supabase 연결 설정
// =====================================================================
//  - SUPABASE_URL : Supabase 대시보드 → Project Settings → API → Project URL
//  - SUPABASE_ANON_KEY : 같은 화면의 anon / publishable key
//
//  anon key 는 "공개용" 키입니다. GitHub Pages 에 올라가도 괜찮습니다.
//  (실제 보안은 DB 의 RLS 정책과 SECURITY DEFINER 함수가 담당합니다)
//
//  !! service_role / secret key 는 절대 여기에 넣지 마세요 !!
// =====================================================================

window.APP_CONFIG = {
  SUPABASE_URL: 'https://ploiejoigoywfltkkzmq.supabase.co',
  SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsb2llam9pZ295d2ZsdGtrem1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0MzQ3NDYsImV4cCI6MjEwNzAxMDc0Nn0.U5szhdcMdTtSDZTp2_CIqPrKdTjVSixnhNJSpo5BkBE',

  // 작품 이미지를 저장하는 Storage 버킷 이름 (schema.sql 에서 만든 것과 같아야 함)
  BUCKET: 'artworks',
};
