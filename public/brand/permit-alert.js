// Permit page alert sign-up dialog. Served as a static asset so the CSP can
// forbid inline scripts and on* handlers (see SECURITY_HEADERS in worker.js).
(function () {
  var leadModal = document.getElementById('leadModal');
  var form = document.getElementById('leadForm');
  if (!leadModal || !form) return;
  var leadTrigger;

  function openModal() {
    leadTrigger = document.activeElement;
    leadModal.showModal();
    var field = document.getElementById('lead-email');
    if (field) field.focus();
  }
  function closeModal() { leadModal.close(); }

  document.querySelectorAll('[data-open-lead-modal]').forEach(function (button) {
    button.addEventListener('click', openModal);
  });
  document.querySelectorAll('[data-close-lead-modal]').forEach(function (button) {
    button.addEventListener('click', closeModal);
  });
  // Clicking the backdrop (the dialog box itself, outside .modal-content) closes it.
  leadModal.addEventListener('click', function (e) { if (e.target === leadModal) closeModal(); });
  leadModal.addEventListener('close', function () { if (leadTrigger && leadTrigger.focus) leadTrigger.focus(); });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var submitBtn = form.querySelector('button[type="submit"]');
    var loader = document.getElementById('submitLoader');
    var text = document.getElementById('submitText');
    text.classList.add('hidden');
    loader.classList.remove('hidden');
    submitBtn.disabled = true;
    var turnstile = form.querySelector('[name="cf-turnstile-response"]');
    var data = {
      email: form.email.value,
      permit_number: form.getAttribute('data-permit-number') || ''
    };
    if (turnstile && turnstile.value) data.turnstile_token = turnstile.value;
    try {
      var response = await fetch('/alerts/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (response.ok) {
        form.style.display = 'none';
        document.getElementById('formSuccess').classList.remove('hidden');
        document.getElementById('formSuccessTitle').focus();
      } else {
        var result = await response.json().catch(function () { return {}; });
        var failure = new Error('Submission failed');
        failure.serverMessage = result.error;
        throw failure;
      }
    } catch (err) {
      var errorEl = document.getElementById('lead-error');
      var emailField = document.getElementById('lead-email');
      errorEl.textContent = (err && err.serverMessage) || "We couldn't save your alert. Check your connection and try again.";
      errorEl.classList.remove('hidden');
      emailField.setAttribute('aria-invalid', 'true');
      emailField.setAttribute('aria-describedby', 'lead-error');
      emailField.focus();
      text.classList.remove('hidden');
      loader.classList.add('hidden');
      submitBtn.disabled = false;
      if (window.turnstile && typeof window.turnstile.reset === 'function') window.turnstile.reset();
    }
  });
})();
