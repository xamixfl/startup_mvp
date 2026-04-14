function readCookie(name) {
  const source = `; ${document.cookie || ''}`;
  const parts = source.split(`; ${name}=`);
  if (parts.length < 2) return '';
  return decodeURIComponent(parts.pop().split(';').shift() || '');
}

function getCsrfToken() {
  return readCookie('csrf_token');
}

function buildHeaders(options = {}) {
  const headers = { ...(options.headers || {}) };
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const hasJsonBody = options.body !== undefined && options.body !== null && !isFormData;

  if (hasJsonBody && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfToken = getCsrfToken();
    if (csrfToken && !headers['X-CSRF-Token']) {
      headers['X-CSRF-Token'] = csrfToken;
    }
  }

  return headers;
}

const api = {
  async request(endpoint, options = {}) {
    const response = await fetch(endpoint, {
      credentials: 'same-origin',
      ...options,
      headers: buildHeaders(options)
    });

    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch (_e) {
        payload = null;
      }
      const error = new Error(payload?.error || `API error: ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return response.json();
  },

  async query(table, action, data = {}, filters = {}) {
    return this.request('/api/query', {
      method: 'POST',
      body: JSON.stringify({ table, action, data, filters })
    });
  },

  async get(table, filters = {}) {
    const result = await this.query(table, 'select', {}, filters);
    return result;
  },

  async getOne(table, id) {
    const result = await this.get(table, { id });
    return result[0] || null;
  },

  async insert(table, data) {
    return this.query(table, 'insert', data);
  },

  async update(table, id, data) {
    return this.query(table, 'update', { id, ...data });
  },

  async delete(table, id) {
    return this.query(table, 'delete', { id });
  },

  async getProfile(userId) {
    return this.request(`/api/profiles/${userId}`);
  },

  async getMeetings() {
    return this.request('/api/meetings');
  },

  async getUserMeetings(userId) {
    return this.get('meetings', { creator_id: userId });
  },

  async getUserChats(userId) {
    return this.get('chat_members', { user_id: userId });
  },

  getCsrfToken,
  buildHeaders
};

window.api = api;
window.getCsrfToken = getCsrfToken;
