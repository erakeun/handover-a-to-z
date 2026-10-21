import { CURRENT_SCHEMA_VERSION, makeId, validateDocument } from './model.js';
import { IMAGE_LIMITS, imageDataURL, imageStats, validateImage } from './image-data.js';
import { preparePhoto } from './image-browser.js';

const size = bytes => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const sectionName = section => section === 'steps' ? '진행 단계' : '하는 방법';

// This module only handles local DOM/file gestures. It never requests clipboard
// permissions, reads the clipboard on its own, or sends files over the network.
export function createPhotoUI({ el, button, field, note, modal, notice, isCurrent, changed, confirmAction }) {
  function enlarge(image, task, section) {
    const body = el('div', {},
      note(`${task.title || '이름 없는 업무'} · ${sectionName(section)}`),
      el('div', { class: 'photo-full-scroll', tabindex: '0', 'aria-label': '사진 원래 크기 보기, 방향키로 이동' },
        el('img', { class: 'photo-full', src: imageDataURL(image), alt: image.caption || `${sectionName(section)} 참고 사진`, width: image.width, height: image.height })),
      image.caption ? el('p', { class: 'pre-wrap photo-caption' }, image.caption) : null,
      note('작은 글씨는 가로·세로로 이동하며 확인하세요. Escape 키로 닫을 수 있습니다.'));
    const handle = modal('사진 크게 보기', body, [close => button('닫기', close)], { stack: true });
    handle.dialog.classList.add('photo-dialog');
  }

  function gallery(task, section, { print = false } = {}) {
    const images = (task.images || []).filter(image => image.section === section);
    if (!images.length) return null;
    return el('div', { class: print ? 'print-photos' : 'photo-gallery', 'aria-label': `${sectionName(section)} 사진` },
      images.map((image, index) => el('figure', { class: 'photo-figure' },
        print
          ? el('img', { src: imageDataURL(image), alt: image.caption || `${sectionName(section)} 사진 ${index + 1}`, width: image.width, height: image.height })
          : button(el('img', { src: imageDataURL(image), alt: image.caption || `${sectionName(section)} 사진 ${index + 1}`, width: image.width, height: image.height, loading: 'lazy' }),
            () => enlarge(image, task, section), 'photo-thumb', { 'aria-label': `${sectionName(section)} 사진 ${index + 1} 크게 보기` }),
        el('figcaption', { class: 'photo-caption pre-wrap' }, image.caption || `${sectionName(section)} · 사진 ${index + 1}`))));
  }

  function decorate(fieldNode, { doc, task, section, allowNew = false }) {
    const container = el('div', { class: 'photo-field', 'data-photo-section': section }, fieldNode);
    const input = fieldNode.querySelector('textarea');
    const status = el('p', { class: 'helper photo-status', role: 'status' });
    const picker = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true, 'aria-label': `${sectionName(section)} 사진 파일` });
    const add = button('사진 넣기', () => picker.click(), 'quiet photo-add', { 'aria-label': `${sectionName(section)}에 사진 넣기` });
    const label = fieldNode.querySelector('label');
    const heading = el('div', { class: 'photo-field-heading' });
    label.replaceWith(heading);
    heading.append(label, add);
    let busy = false;
    const validTarget = () => container.isConnected && isCurrent(doc.id) && (doc.tasks.includes(task) || (allowNew && !doc.tasks.some(t => t.id === task.id)));
    const report = message => { status.textContent = message; status.setAttribute('role', 'alert'); };

    async function receive(files) {
      if (busy) { report('앞선 사진을 확인한 뒤 다음 사진을 넣어 주세요.'); return; }
      if (!files.length) return;
      if (files.length !== 1) { report('사진은 한 번에 한 장씩 넣어 주세요.'); return; }
      if (!validTarget()) return;
      const stats = imageStats(doc);
      if ((task.images?.length || 0) >= IMAGE_LIMITS.perTask || stats.count >= IMAGE_LIMITS.perDocument) {
        report(`업무당 ${IMAGE_LIMITS.perTask}장, 문서당 ${IMAGE_LIMITS.perDocument}장까지 담을 수 있습니다.`); return;
      }
      busy = true; add.disabled = true; picker.disabled = true;
      status.setAttribute('role', 'status'); status.textContent = '기기 안에서 사진을 확인하는 중입니다…';
      try {
        const prepared = await preparePhoto(files[0]);
        if (!validTarget()) return;
        let caption = '';
        const pixels = prepared.lossless || prepared.compact;
        if (!pixels) throw new Error('사진을 읽지 못했습니다. 다른 사진 파일을 선택해 주세요.');
        const photo = { id: makeId(), section, caption: '', ...pixels };
        const reduced = !prepared.lossless;
        const previewError = el('p', { class: 'error', role: 'alert' });
        const body = el('div', {},
          note(`${task.title || '첫 업무'} · ${sectionName(section)}에 연결됩니다.`),
          el('img', { class: 'photo-review', src: imageDataURL(photo), width: photo.width, height: photo.height, alt: '추가할 사진 미리보기' }),
          button('사진을 크게 확인', () => {
            try { validateImage({ ...photo, caption }); }
            catch (error) { previewError.textContent = '사진 설명을 확인해 주세요. ' + error.message; return; }
            enlarge({ ...photo, caption }, task, section);
          }, 'quiet'),
          note(`${prepared.original.width} × ${prepared.original.height} → 저장 ${photo.width} × ${photo.height} · 약 ${size(Math.floor(photo.data.length * 3 / 4))}`),
          reduced ? el('p', { class: 'callout warning' }, '용량을 줄인 사진입니다. 글씨가 흐려지지 않았는지 확인한 뒤 추가하세요. 부족하면 취소하고 필요한 부분만 잘라 넣어 주세요. JPEG로 바꾸며 투명한 부분은 흰색이 됩니다.') : note('원래 픽셀 크기를 유지합니다. 촬영 위치 등 부가정보는 제거하고 PNG로 담습니다.'),
          field('짧은 설명 (선택)', '', value => caption = value, { maxLength: IMAGE_LIMITS.caption, placeholder: section === 'steps' ? '예: 2단계 — 조회 기간을 선택하는 위치' : '예: 화면 오른쪽 위의 신청 버튼' }),
          note('사진 안의 개인정보·비밀번호·인증키도 직접 확인해 주세요. 사진은 서버로 보내지 않고 전달·백업 JSON에 함께 담습니다.'), previewError);
        const preview = modal('사진을 확인해 주세요', body, [
          close => button('취소', close),
          close => button(reduced ? '줄인 사진 추가' : '사진 추가', () => {
            if (!validTarget()) { close(); notice('작성 화면이 바뀌어 사진을 추가하지 않았습니다.'); return; }
            const image = { ...photo, caption };
            const candidate = structuredClone(doc);
            let candidateTask = candidate.tasks.find(t => t.id === task.id);
            if (!candidateTask) { candidateTask = structuredClone(task); candidate.tasks.push(candidateTask); }
            candidateTask.images = [...(candidateTask.images || []), image];
            candidate.schemaVersion = CURRENT_SCHEMA_VERSION;
            const result = validateDocument(candidate);
            if (!result.ok) { previewError.textContent = '추가하지 않았습니다. ' + result.errors.join(' '); return; }
            if (!doc.tasks.includes(task)) doc.tasks.push(task);
            task.images = candidateTask.images; doc.schemaVersion = CURRENT_SCHEMA_VERSION;
            close(); changed(task.id);
          }, 'primary'),
        ]);
        preview.dialog.classList.add('photo-dialog');
        status.textContent = '';
      } catch (error) { if (validTarget()) report(error.message); }
      finally { busy = false; add.disabled = false; picker.disabled = false; picker.value = ''; }
    }
    picker.addEventListener('change', () => receive([...picker.files || []]));
    container.addEventListener('dragover', event => {
      if ([...event.dataTransfer?.types || []].includes('Files')) { event.preventDefault(); container.classList.add('is-dragging'); }
    });
    container.addEventListener('dragleave', () => container.classList.remove('is-dragging'));
    container.addEventListener('drop', event => {
      const files = [...event.dataTransfer?.files || []];
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation(); container.classList.remove('is-dragging'); receive(files);
    });
    input.addEventListener('paste', event => {
      const files = [...event.clipboardData?.items || []].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
      if (!files.length) return; // Ordinary text/table paste stays untouched.
      event.preventDefault(); receive(files);
    });
    const items = el('div', { class: 'photo-edit-list' });
    for (const image of (task.images || []).filter(image => image.section === section)) {
      items.append(el('div', { class: 'photo-edit-item' },
        button(el('img', { src: imageDataURL(image), alt: image.caption || '첨부한 사진', width: image.width, height: image.height }),
          () => enlarge(image, task, section), 'photo-thumb', { 'aria-label': `${image.caption || sectionName(section) + ' 사진'} 크게 보기` }),
        el('div', {}, field('사진 설명 (선택)', image.caption, value => {
          try { validateImage({ ...image, caption: value }); }
          catch (error) { report('입력한 사진 설명을 저장하지 않았습니다. 이전 설명은 유지됩니다. ' + error.message); return; }
          status.textContent = ''; image.caption = value; changed(task.id, false);
        }, { maxLength: IMAGE_LIMITS.caption }),
          button('사진 삭제', () => confirmAction('사진을 삭제할까요?', `${image.caption || sectionName(section) + ' 사진'} — 이 문서에서만 지웁니다. 이전에 받은 JSON 파일과 원본 사진은 바뀌지 않습니다.`, () => {
            if (!validTarget()) return;
            task.images = task.images.filter(item => item.id !== image.id); changed(task.id);
          }), 'quiet danger-text'))));
    }
    container.append(picker, note('사진을 이 설명 칸에 끌어놓거나, 복사한 사진을 붙여넣어도 됩니다.'), status, items,
      el('details', { class: 'photo-help' }, el('summary', {}, '사진 용량·저장 안내'),
        note('JPEG·PNG·WebP, 원본 8 MiB·1,600만 픽셀까지. 저장 사진은 한 장 2 MiB, 업무당 20장, 문서당 100장·합계 16 MiB까지입니다. 사진을 포함한 JSON은 24 MiB 이하여야 합니다.'),
        note('사진을 담으면 JSON 파일이 커집니다. 큰 사진은 줄인 결과를 먼저 확인합니다. 기기 임시저장 공간이 부족하면 화면에만 남을 수 있으니 저장 상태를 확인하고 JSON 파일을 직접 받아 보관하세요. 사진이 있는 JSON은 사진 기능을 지원하는 새 버전에서 열어 주세요.')));
    return container;
  }
  return { decorate, gallery };
}
