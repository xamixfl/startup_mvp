// Quick verification script for Supabase migration issues
// Copy and paste into browser console (F12)

console.group('🔍 Supabase Chat Diagnostics');

// Test 1: Auth session
(async () => {
  const result = await window.APP.supabase.auth.getSession();
  console.log('✓ Session valid:', !!result.data?.session);
})();

// Test 2: Supabase client
console.log('✓ Supabase client:', typeof window.APP.supabase);

// Test 3: Table configs
console.log('✓ TABLES config:', window.APP.TABLES);

// Test 4: Current user
console.log('✓ currentUser:', typeof currentUser !== 'undefined' ? currentUser?.id : 'NOT DEFINED');

// Test 5: Quick data checks
(async () => {
  try {
    const chats = await window.APP.supabase
      .from('chats')
      .select('count(*)', { count: 'exact' });
    console.log('✓ Chats table:', chats.error ? '❌ ERROR: ' + chats.error.message : '✓ Accessible');
    
    const members = await window.APP.supabase
      .from('chat_members')
      .select('count(*)', { count: 'exact' });
    console.log('✓ Chat members table:', members.error ? '❌ ERROR: ' + members.error.message : '✓ Accessible');
    
    const profiles = await window.APP.supabase
      .from('profiles')
      .select('count(*)', { count: 'exact' });
    console.log('✓ Profiles table:', profiles.error ? '❌ ERROR: ' + profiles.error.message : '✓ Accessible');
  } catch (e) {
    console.error('❌ Test error:', e.message);
  }
})();

// Test 6: Load chats manually
console.log('--- Manual Chat Load Test ---');
if (typeof loadChats === 'function') {
  console.log('✓ loadChats function exists');
  // await loadChats(); // Uncomment to trigger actual load
} else {
  console.warn('⚠️ loadChats function not found');
}

console.groupEnd();
