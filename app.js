/* 저택 초대장 · 화면과 예약 연결 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SLOT_LABELS = {
    '2026-11-14-14': '11월 14일 오후 2시',
    '2026-11-14-19': '11월 14일 오후 7시',
    '2026-11-15-14': '11월 15일 오후 2시',
    '2026-11-15-19': '11월 15일 오후 7시'
  };
  const ITEM_IMAGES = {
    book: { src: 'book.webp', title: '이방인' },
    revolver: { src: 'revolver.webp', title: '리볼버' },
    family: { src: 'family.webp', title: '가족사진' }
  };
  let currentStep = 1;
  let guestNames = [];
  let phone = '';
  let selectedSlot = '';
  let slots = {};
  let serverReady = false;
  let reservationRequestId = null;
  let reservationDone = false;
  let submitting = false;
  const discovered = new Set();
  const preview = new URLSearchParams(location.search).get('preview') === '1';
  const url = String(window.BOOKING_CONFIG?.gasWebAppUrl || '').trim();
  const configured = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url);

  function showStep(step) {
    currentStep = step;
    document.querySelectorAll('[data-screen]').forEach(screen => {
      const open = String(screen.dataset.screen) === String(step);
      screen.hidden = !open;
      screen.classList.toggle('active', open);
    });
    $('stepNumber').textContent = step === 'notice' ? '05' : String(step).padStart(2, '0');
    window.scrollTo(0, 0);
    if (step === 3) refreshAvailability();
    if (step === 4) {
      requestAnimationFrame(() => {
        const view = $('roomViewport');
        if (view && !view.dataset.positioned) {
          view.scrollLeft = Math.max(0, (view.scrollWidth - view.clientWidth) * .28);
          view.dataset.positioned = 'yes';
        }
      });
    }
  }
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.hidden = true, 3800);
  }
  function setError(id, message) {
    $(id).textContent = message;
    $(id).hidden = !message;
  }
  function addNameField() {
    const count = document.querySelectorAll('#nameFields input').length;
    if (count >= 4) return;
    const label = document.createElement('label');
    label.className = 'field';
    const title = document.createElement('span');
    title.textContent = `동행인 이름 ${String(count + 1).padStart(2, '0')}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove-guest';
    remove.textContent = '삭제';
    remove.addEventListener('click', () => {
      label.remove();
      $('addGuest').disabled = false;
    });
    title.append(remove);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 32;
    input.placeholder = '동행인의 이름';
    input.autocomplete = 'off';
    input.required = true;
    label.append(title, input);
    $('nameFields').append(label);
    $('addGuest').disabled = count + 1 >= 4;
    input.focus();
  }
  $('addGuest').addEventListener('click', addNameField);
  $('enterButton').addEventListener('click', () => showStep(2));
  $('guestForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const names = Array.from(document.querySelectorAll('#nameFields input')).map(el => el.value.trim());
    const digits = $('phoneInput').value.replace(/\D/g, '');
    if (names.some(n => !n || n.length > 32 || !/^[\p{L} .'-]{1,32}$/u.test(n))) {
      setError('guestError', '방문자와 동행인의 이름을 정확히 입력해주세요.'); return;
    }
    if (!/^01\d{8,9}$/.test(digits)) {
      setError('guestError', '연락처는 010-1234-5678 형태의 휴대전화 번호로 입력해주세요.'); return;
    }
    if (!$('privacyConsent').checked) {
      setError('guestError', '개인정보 수집 및 이용 동의가 필요합니다.'); return;
    }
    setError('guestError', '');
    guestNames = names;
    phone = digits;
    reservationRequestId = null;
    showStep(3);
  });

  function makeId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  // GET 요청에는 공개 예약 현황 및 무작위 요청 번호만 보냅니다. 개인정보는 절대 넣지 않습니다.
  function publicQuery(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!configured) return reject(new Error('예약 서버가 연결되지 않았습니다.'));
      const callback = '__horror_cb_' + makeId().replace(/-/g, '_');
      const script = document.createElement('script');
      let finished = false;
      const done = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        delete window[callback];
        script.remove();
        if (error) reject(error); else resolve(value);
      };
      const timeout = setTimeout(() => done(new Error('예약 서버에 연결할 수 없습니다.')), 15000);
      window[callback] = data => done(null, data);
      script.onerror = () => done(new Error('예약 서버 조회에 실패했습니다.'));
      const query = new URLSearchParams({ action, ...params, callback, _: String(Date.now()) });
      script.src = url + '?' + query.toString();
      document.head.appendChild(script);
    });
  }
  // 개인정보는 POST 본문으로만 보냅니다. GAS의 CORS 제약 때문에 결과는 요청번호로 따로 확인합니다.
  async function submitBooking(data) {
    try {
      await fetch(url, {
        method: 'POST', mode: 'no-cors', credentials: 'omit',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ payload: JSON.stringify(data) })
      });
    } catch (error) {
      // 네트워크 오류가 있어도 서버에서 접수가 진행됐을 수 있으므로 요청번호를 먼저 확인합니다.
      console.warn('예약 전송 응답을 확인할 수 없어 예약번호로 재확인합니다.');
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise(resolve => setTimeout(resolve, attempt < 2 ? 700 : 1500));
      let status;
      try {
        status = await publicQuery('status', { requestId: data.requestId });
      } catch (error) {
        continue; // 일시적인 조회 장애는 다시 확인합니다.
      }
      if (status.status === 'confirmed') return { status: 'confirmed' };
      if (status.status === 'rejected') throw new Error(status.error || '예약이 거절되었습니다.');
    }
    throw new Error('예약 처리 결과를 확인하지 못했습니다. 중복 신청하지 말고 제작자에게 예약 여부를 먼저 확인해주세요.');
  }

  function setOfflinePreview() {
    slots = Object.fromEntries(Object.keys(SLOT_LABELS).map(id => [id, { remaining: 10, closed: false }]));
    paintSlots();
    $('availabilityMessage').textContent = '미리보기 모드: 실제 예약은 저장되지 않습니다.';
  }
  async function refreshAvailability() {
    if (preview) return setOfflinePreview();
    if (!configured) {
      $('availabilityMessage').textContent = '예약 서버 설정이 필요합니다. 사이트 관리자에게 문의해주세요.';
      paintSlots(); return;
    }
    try {
      const result = await publicQuery('availability');
      if (result.error) throw new Error(result.error);
      serverReady = true;
      slots = Object.fromEntries((result.slots || []).map(slot => [slot.id, slot]));
      $('availabilityMessage').textContent = '실시간 예약 현황입니다. 마감된 시간은 선택할 수 없습니다.';
      if (selectedSlot && (slots[selectedSlot]?.closed || slots[selectedSlot]?.remaining < guestNames.length)) selectedSlot = '';
      paintSlots();
    } catch (error) {
      slots = {};
      $('availabilityMessage').textContent = error.message;
      paintSlots();
    }
  }
  function paintSlots() {
    document.querySelectorAll('.slot-button').forEach(button => {
      const slot = slots[button.dataset.slot];
      const closed = !!slot && (slot.closed || slot.remaining < Math.max(guestNames.length, 1));
      const usable = !!slot && !closed && (preview || serverReady);
      button.disabled = !usable;
      button.classList.toggle('is-closed', closed);
      button.setAttribute('aria-pressed', String(button.dataset.slot === selectedSlot));
      const accessible = SLOT_LABELS[button.dataset.slot];
      button.setAttribute('aria-label', `${accessible}${closed ? ' 마감' : slot ? ' 남은 자리 ' + slot.remaining + '명' : ' 확인 중'}`);
    });
    $('confirmButton').disabled = !selectedSlot || submitting || (!serverReady && !preview) || reservationDone;
    $('selectionSummary').textContent = selectedSlot ? `${SLOT_LABELS[selectedSlot]} · ${guestNames.length}명` : '방문 시간을 하나 선택하세요.';
  }
  document.querySelectorAll('.slot-button').forEach(button => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      selectedSlot = button.dataset.slot;
      reservationRequestId = null;
      setError('bookingError', '');
      paintSlots();
    });
  });
  $('confirmButton').addEventListener('click', async () => {
    if (!selectedSlot || submitting || reservationDone) return;
    if (preview) {
      $('availabilityMessage').textContent = '미리보기 모드이므로 실제 예약은 진행되지 않습니다.';
      toast('미리보기에서는 예약 정보를 전송하지 않습니다.');
      reservationDone = true;
      $('finalSummary').textContent = `${SLOT_LABELS[selectedSlot]} · ${guestNames.length}명 (미리보기)`;
      $('noticeConfirmed').textContent = '미리보기입니다. 실제 예약은 접수되지 않았습니다.';
      showStep(4);
      return;
    }
    submitting = true;
    setError('bookingError', '');
    $('confirmButton').textContent = '예약 확인 중…';
    paintSlots();
    if (!reservationRequestId) reservationRequestId = makeId();
    try {
      const result = await submitBooking({
        requestId: reservationRequestId,
        names: guestNames,
        phone,
        slotId: selectedSlot,
        agreed: true
      });
      if (result.status !== 'confirmed') throw new Error('예약이 확정되지 않았습니다.');
      reservationDone = true;
      $('finalSummary').textContent = `${SLOT_LABELS[selectedSlot]} · ${guestNames.length}명`;
      $('noticeConfirmed').textContent = '당신의 방문이 등록되었습니다.';
      toast('방문 예약이 확정되었습니다.');
      showStep(4);
    } catch (error) {
      setError('bookingError', error.message);
      await refreshAvailability();
    } finally {
      submitting = false;
      $('confirmButton').textContent = '방문 예약 확정';
      paintSlots();
    }
  });

  document.querySelectorAll('[data-item]').forEach(button => {
    button.addEventListener('click', () => {
      const id = button.dataset.item;
      const item = ITEM_IMAGES[id];
      if (!item) return;
      discovered.add(id);
      $('discoveryCount').textContent = String(discovered.size);
      $('itemImage').src = item.src;
      $('itemImage').alt = `${item.title} 단서 이미지`;
      $('itemTitle').textContent = item.title;
      $('itemModal').hidden = false;
      $('closeItem').focus();
    });
  });
  function closeModal() { $('itemModal').hidden = true; }
  $('closeItem').addEventListener('click', closeModal);
  $('itemBack').addEventListener('click', closeModal);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('itemModal').hidden) closeModal(); });
  $('nextFromRoom').addEventListener('click', () => showStep(5));
  $('revealNotice').addEventListener('click', () => showStep('notice'));
  $('restartButton').addEventListener('click', () => {
    // 기존 예약을 다시 접수하지 않도록 화면만 시작 위치로 되돌립니다.
    selectedSlot = '';
    guestNames = [];
    phone = '';
    reservationRequestId = null;
    reservationDone = false;
    discovered.clear();
    $('guestForm').reset();
    document.querySelectorAll('#nameFields .field').forEach((field, index) => { if (index > 0) field.remove(); });
    $('addGuest').disabled = false;
    $('discoveryCount').textContent = '0';
    $('roomViewport').dataset.positioned = '';
    showStep(1);
  });
  if (!configured && !preview) console.warn('예약 서버 URL을 config.js에서 설정해주세요.');
  showStep(1);
})();
