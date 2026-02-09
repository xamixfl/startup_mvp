const SUPABASE_URL = (window.ENV && window.ENV.SUPABASE_URL) || '';
const SUPABASE_ANON_KEY = (window.ENV && window.ENV.SUPABASE_ANON_KEY) || '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Supabase env is missing. Check env.js.');
}

window.APP = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  supabase: window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY),
  TABLES: {
    profiles: 'profiles',
    meetings: 'meetings',
    participants: 'table-connector'
  }
};

console.log('Supabase config loaded', window.APP);
