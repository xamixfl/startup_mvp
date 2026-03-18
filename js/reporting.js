/**
 * Reporting Modal Manager
 * Handles report modal for chats, users, and events
 */

const REPORT_REASONS = {
  inappropriate: 'Неуместный контент',
  harassment: 'Преследование/Оскорбления',
  spam: 'Спам',
  fraud: 'Мошенничество',
  other: 'Другое'
};

let reportModal = null;
let currentReportTarget = null;

/**
 * Initialize report modal in the page
 */
function initReportModal() {
  if (reportModal) return; // Already initialized

  const modal = document.createElement('div');
  modal.id = 'report-modal';
  modal.innerHTML = `
    <div class="modal-overlay" id="report-modal-overlay">
      <div class="modal-content">
        <div class="modal-header">
          <h2>Пожаловаться</h2>
          <button class="modal-close" id="report-modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div id="report-target-info" style="margin-bottom: 16px; padding: 12px; background: #f8fafc; border-radius: 8px; font-size: 14px;">
          </div>
          
          <div style="margin-bottom: 16px;">
            <label for="report-reason" style="display: block; margin-bottom: 8px; font-weight: 600;">Причина жалобы:</label>
            <select id="report-reason" style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 8px; font-family: 'Poppins', sans-serif; font-size: 14px;">
              <option value="">Выберите причину...</option>
              ${Object.entries(REPORT_REASONS).map(([key, value]) => 
                `<option value="${key}">${value}</option>`
              ).join('')}
            </select>
          </div>

          <div style="margin-bottom: 16px;">
            <label for="report-description" style="display: block; margin-bottom: 8px; font-weight: 600;">Дополнительная информация:</label>
            <textarea 
              id="report-description" 
              placeholder="Опишите проблему (опционально)" 
              style="width: 100%; padding: 10px; border: 1px solid #e2e8f0; border-radius: 8px; font-family: 'Poppins', sans-serif; font-size: 14px; min-height: 100px; resize: vertical;"
            ></textarea>
          </div>

          <div id="report-message" style="margin-bottom: 16px; padding: 12px; border-radius: 8px; display: none;"></div>
        </div>
        <div class="modal-footer">
          <button id="report-cancel" class="btn-secondary">Отмена</button>
          <button id="report-submit" class="btn-primary">Отправить жалобу</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  reportModal = modal;

  // Add event listeners
  document.getElementById('report-modal-close').addEventListener('click', closeReportModal);
  document.getElementById('report-modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('report-modal-overlay')) {
      closeReportModal();
    }
  });
  document.getElementById('report-cancel').addEventListener('click', closeReportModal);
  document.getElementById('report-submit').addEventListener('click', submitReportHandler);

  // Add Escape key handler
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('report-modal-overlay').classList.contains('active')) {
      closeReportModal();
    }
  });

  // Add styles if not already added
  addReportModalStyles();
}

/**
 * Add modal styles to the page
 */
function addReportModalStyles() {
  if (document.getElementById('report-modal-styles')) return;

  const style = document.createElement('style');
  style.id = 'report-modal-styles';
  style.textContent = `
    #report-modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 999;
      pointer-events: none;
    }

    .modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      justify-content: center;
      align-items: center;
      z-index: 999;
      pointer-events: all;
    }

    .modal-overlay.active {
      display: flex;
    }

    .modal-content {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      width: 90%;
      max-width: 500px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      animation: slideUp 0.3s ease;
    }

    @keyframes slideUp {
      from {
        transform: translateY(20px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px;
      border-bottom: 1px solid #e2e8f0;
    }

    .modal-header h2 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
    }

    .modal-close {
      background: none;
      border: none;
      font-size: 28px;
      cursor: pointer;
      color: #64748b;
      padding: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 8px;
      transition: all 0.2s;
    }

    .modal-close:hover {
      background: #f1f5f9;
      color: #1e293b;
    }

    .modal-body {
      padding: 20px;
      overflow-y: auto;
      flex: 1;
    }

    .modal-footer {
      display: flex;
      gap: 12px;
      padding: 20px;
      border-top: 1px solid #e2e8f0;
      justify-content: flex-end;
    }

    .btn-primary,
    .btn-secondary {
      padding: 10px 16px;
      border-radius: 8px;
      border: none;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      font-family: 'Poppins', sans-serif;
      font-size: 14px;
    }

    .btn-primary {
      background: #3b82f6;
      color: white;
    }

    .btn-primary:hover {
      background: #2563eb;
    }

    .btn-primary:disabled {
      background: #cbd5e1;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: #f1f5f9;
      color: #1e293b;
    }

    .btn-secondary:hover {
      background: #e2e8f0;
    }

    #report-message {
      font-size: 14px;
    }

    #report-message.success {
      background: #d1fae5;
      border: 1px solid #6ee7b7;
      color: #065f46;
    }

    #report-message.error {
      background: #fee2e2;
      border: 1px solid #fecaca;
      color: #991b1b;
    }
  `;

  document.head.appendChild(style);
}

/**
 * Open report modal for a specific target
 */
function openReportModal(targetType, targetId, targetInfo) {
  // Lazy initialization - only create modal when first needed
  if (!reportModal) {
    initReportModal();
  }
  
  currentReportTarget = {
    type: targetType,
    target_id: targetId,
    info: targetInfo
  };

  const infoDiv = document.getElementById('report-target-info');
  const typeLabel = {
    chat: 'Жалоба на чат:',
    user: 'Жалоба на пользователя:',
    event: 'Жалоба на встречу:'
  }[targetType] || 'Жалоба:';

  infoDiv.innerHTML = `<strong>${typeLabel}</strong> ${targetInfo}`;

  // Reset form
  document.getElementById('report-reason').value = '';
  document.getElementById('report-description').value = '';
  document.getElementById('report-message').style.display = 'none';
  document.getElementById('report-message').textContent = '';

  // Show modal
  document.getElementById('report-modal-overlay').classList.add('active');
}

/**
 * Close report modal
 */
function closeReportModal() {
  if (reportModal) {
    const overlay = document.getElementById('report-modal-overlay');
    const submitBtn = document.getElementById('report-submit');
    
    if (overlay) {
      overlay.classList.remove('active');
    }
    
    // Reset form state
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Отправить жалобу';
    }
    
    // Clear form
    const reasonSelect = document.getElementById('report-reason');
    const descriptionInput = document.getElementById('report-description');
    const messageDiv = document.getElementById('report-message');
    
    if (reasonSelect) reasonSelect.value = '';
    if (descriptionInput) descriptionInput.value = '';
    if (messageDiv) {
      messageDiv.style.display = 'none';
      messageDiv.textContent = '';
    }
    
    currentReportTarget = null;
  }
}

/**
 * Handle report submission
 */
async function submitReportHandler() {
  if (!currentReportTarget) return;

  const reason = document.getElementById('report-reason').value;
  if (!reason) {
    showReportMessage('Пожалуйста, выберите причину жалобы', 'error');
    return;
  }

  const description = document.getElementById('report-description').value;
  const submitBtn = document.getElementById('report-submit');
  
  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Отправка...';

    // Get current user ID
    const user = typeof window.getCurrentUser === 'function'
      ? await window.getCurrentUser()
      : await api.request('/api/auth/me');
    if (!user) {
      showReportMessage('Пожалуйста, войдите в систему', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Отправить жалобу';
      return;
    }

    // Submit report using ReportService
    const result = await window.ReportService.submitReport(
      currentReportTarget.type,
      currentReportTarget.target_id,
      user.id,
      reason,
      description
    );

    if (result.success) {
      showReportMessage('Спасибо! Ваша жалоба отправлена нашей команде модерации.', 'success');
      setTimeout(() => {
        closeReportModal();
      }, 1500);
    } else {
      showReportMessage(result.error || 'Ошибка при отправке жалобы', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Отправить жалобу';
    }
  } catch (error) {
    console.error('Error submitting report:', error);
    showReportMessage('Произошла ошибка при отправке жалобы', 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Отправить жалобу';
  }
}

/**
 * Show message in the report modal
 */
function showReportMessage(message, type) {
  const messageDiv = document.getElementById('report-message');
  messageDiv.textContent = message;
  messageDiv.className = type;
  messageDiv.style.display = 'block';
}

/**
 * Create report button element
 */
function createReportButton(targetType, targetId, targetInfo) {
  const btn = document.createElement('button');
  btn.className = 'btn-report';
  btn.innerHTML = '⚠️ Пожаловаться';
  btn.title = 'Пожаловаться на ' + (
    targetType === 'chat' ? 'чат' :
    targetType === 'user' ? 'пользователя' :
    'встречу'
  );
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openReportModal(targetType, targetId, targetInfo);
  });
  return btn;
}

// Make functions globally available
window.openReportModal = openReportModal;
window.closeReportModal = closeReportModal;
window.createReportButton = createReportButton;
window.initReportModal = initReportModal;
