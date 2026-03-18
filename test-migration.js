// Quick verification script for API migration
// Copy and paste into browser console (F12) on any page that loads `js/api.js`.

console.group('API Diagnostics');

(async () => {
  try {
    const health = await fetch('/api/health').then(r => r.json());
    console.log('✓ /api/health:', health);
  } catch (e) {
    console.error('✗ /api/health failed:', e.message || e);
  }

  try {
    console.log('✓ api global:', typeof api);
  } catch (_e) {
    console.error('✗ api is not defined (check <script src=\"js/api.js\"> order)');
  }

  try {
    const me = await api.request('/api/auth/me', { method: 'GET' });
    console.log('✓ /api/auth/me:', me ? { id: me.id, email: me.email, role: me.role } : null);
  } catch (e) {
    console.error('✗ /api/auth/me failed:', e.message || e);
  }

  try {
    const tables = window.APP && window.APP.TABLES ? window.APP.TABLES : null;
    console.log('✓ TABLES config:', tables);
  } catch (_e) {}

  try {
    const profilesCount = await api.query('profiles', 'count', {}, {});
    console.log('✓ profiles count:', profilesCount);
  } catch (e) {
    console.error('✗ profiles count failed:', e.message || e);
  }

  try {
    const meetingsCount = await api.query('meetings', 'count', {}, {});
    console.log('✓ meetings count:', meetingsCount);
  } catch (e) {
    console.error('✗ meetings count failed:', e.message || e);
  }
})();

console.groupEnd();

