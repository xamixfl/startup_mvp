(function () {
  const STORAGE_KEY = 'pulse_beta_disclaimer_dismissed_session_v1';
  const NODE_ID = 'pulse-beta-disclaimer';

  function ensureStyles() {
    if (document.getElementById('beta-disclaimer-styles')) return;
    const style = document.createElement('style');
    style.id = 'beta-disclaimer-styles';
    style.textContent = `
      .beta-disclaimer {
        position: fixed;
        bottom: 18px;
        right: 18px;
        width: min(360px, calc(100vw - 32px));
        z-index: 5000;
        background: linear-gradient(135deg, #fff7d6 0%, #fef3c7 100%);
        color: #78350f;
        border: 1px solid #f5d77a;
        border-radius: 16px;
        box-shadow: 0 18px 42px rgba(146, 64, 14, 0.16);
        padding: 14px 16px 14px 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        animation: betaDisclaimerEnter 180ms ease-out;
      }

      .beta-disclaimer[hidden] {
        display: none;
      }

      .beta-disclaimer-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .beta-disclaimer-title {
        font-size: 14px;
        font-weight: 800;
        line-height: 1.2;
      }

      .beta-disclaimer-copy {
        font-size: 13px;
        line-height: 1.45;
        color: #92400e;
      }

      .beta-disclaimer-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .beta-disclaimer-btn,
      .beta-disclaimer-close {
        border: none;
        cursor: pointer;
        font: inherit;
      }

      .beta-disclaimer-btn {
        padding: 8px 12px;
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.72);
        color: #78350f;
        font-size: 12px;
        font-weight: 700;
      }

      .beta-disclaimer-btn:hover {
        background: rgba(255, 255, 255, 0.92);
      }

      .beta-disclaimer-close {
        width: 28px;
        height: 28px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.68);
        color: #92400e;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-size: 16px;
        font-weight: 700;
      }

      .beta-disclaimer-close:hover {
        background: rgba(255, 255, 255, 0.92);
      }

      @keyframes betaDisclaimerEnter {
        from {
          opacity: 0;
          transform: translateY(-8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @media (max-width: 640px) {
        .beta-disclaimer {
          bottom: 16px;
          right: 16px;
          left: 16px;
          width: auto;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function dismiss(node) {
    try {
      sessionStorage.setItem(STORAGE_KEY, '1');
    } catch (_e) {}
    if (node) node.remove();
  }

  function showDisclaimer() {
    if (!document.body) return;
    try {
      if (sessionStorage.getItem(STORAGE_KEY) === '1') return;
    } catch (_e) {}
    if (document.getElementById(NODE_ID)) return;

    ensureStyles();

    const node = document.createElement('aside');
    node.id = NODE_ID;
    node.className = 'beta-disclaimer';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.innerHTML = `
      <div class="beta-disclaimer-header">
        <div class="beta-disclaimer-title">Бета-версия</div>
        <button type="button" class="beta-disclaimer-close" aria-label="Закрыть уведомление">×</button>
      </div>
      <div class="beta-disclaimer-copy">
        Pulse все еще находится в бета-версии. Некоторые функции могут меняться, работать нестабильно или временно исчезать. Если заметите проблему или захотите поделиться идеей, пожалуйста, отправьте нам обратную связь.
      </div>
      <div class="beta-disclaimer-actions">
        <button type="button" class="beta-disclaimer-btn">Понятно</button>
      </div>
    `;

    const closeBtn = node.querySelector('.beta-disclaimer-close');
    const actionBtn = node.querySelector('.beta-disclaimer-btn');
    if (closeBtn) closeBtn.onclick = () => dismiss(node);
    if (actionBtn) actionBtn.onclick = () => dismiss(node);

    document.body.appendChild(node);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showDisclaimer, { once: true });
  } else {
    showDisclaimer();
  }
})();
