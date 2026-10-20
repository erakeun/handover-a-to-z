import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeDraftTitles } from '../src/draft-titles.js';

const page = text => ({ text, kind: 'page', source: '[가상] 문서 · 1쪽' });

test('leading page numbers and clear reference dates are skipped only for title proposals', () => {
  const blocks = [
    page('- 1 -\r\n2026.10.20. 기준\r\n가상 자료 점검\r\n원문\t본문'),
    page('제 2 쪽\n작성 기준일: 2026-10-20\n가상 행사 준비'),
    page('Page 3 of 8\n2026년 10월 기준\n가상 회의 운영'),
    page('4\n기준: 2026.10\n가상 보고서'),
    page('5페이지\n기준일：2026.10.20\n가상 분류'),
  ];
  const before = structuredClone(blocks);
  assert.deepEqual(proposeDraftTitles(blocks), ['가상 자료 점검', '가상 행사 준비', '가상 회의 운영', '가상 보고서', '가상 분류']);
  assert.deepEqual(blocks, before);
});

test('normal numbered actions and dates inside task text are not treated as page furniture', () => {
  const texts = ['1. 자료를 확인합니다', '1) 시작 전에 승인 확인', '제1쪽 내용을 확인합니다', '2026년 회의 진행', '2026.10.20 기준 자료를 확인합니다'];
  assert.deepEqual(proposeDraftTitles(texts.map(page)), texts);
});

test('repeated page headers gain distinct short subtitles without making groups or editing bodies', () => {
  const blocks = [
    page('가상 운영 업무\n자료 접수\n설명 원문'),
    page('가상 운영 업무\n결과 확인\n설명 원문'),
    page('- 3 -\n다른 가상 업무\n설명 원문'),
  ];
  const before = structuredClone(blocks);
  assert.deepEqual(proposeDraftTitles(blocks), ['가상 운영 업무 — 자료 접수', '가상 운영 업무 — 결과 확인', '다른 가상 업무']);
  assert.deepEqual(blocks, before);
});

test('repeated slide headers are supported but paragraph and paste blocks do not gain a guessed hierarchy', () => {
  const blocks = [
    { text: '가상 발표\n시작 준비', kind: 'slide' },
    { text: '가상 발표\n종료 확인', kind: 'slide' },
    { text: '가상 메모\n같은 제목 아래 본문', kind: 'paragraph' },
    { text: '가상 메모\n다른 본문', kind: 'paragraph' },
  ];
  assert.deepEqual(proposeDraftTitles(blocks), ['가상 발표 — 시작 준비', '가상 발표 — 종료 확인', '가상 메모', '가상 메모']);
});

test('only a page number, reference date, or blank content yields an honest generic title', () => {
  assert.deepEqual(proposeDraftTitles(['-24-', '제1쪽', '  \r\n\t', '2026.10.20 기준\n- 2 -'].map(page)),
    ['내용 확인 필요', '내용 확인 필요', '내용 확인 필요', '내용 확인 필요']);
});

test('long body paragraphs are not promoted to subtitles and output is bounded without broken Unicode', () => {
  const header = '가상 운영';
  const long = '긴 본문 '.repeat(100);
  const blocks = [page(`${header}\n${long}`), page(`${header}\n다음 처리`), page('🐻'.repeat(60))];
  const titles = proposeDraftTitles(blocks);
  assert.equal(titles[0], header);
  assert.equal(titles[1], '가상 운영 — 다음 처리');
  for (const title of titles) {
    assert.ok(title.length <= 80);
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(title)), title);
  }
  assert.equal(blocks[0].text, `${header}\n${long}`);
});

test('length-limited combined titles retain both the repeated context and distinguishing subtitle', () => {
  const header = '가상 큰 제목 '.repeat(8).trim();
  const a = '가상 세부 업무 A '.repeat(5).trim();
  const b = '가상 세부 업무 B '.repeat(5).trim();
  const titles = proposeDraftTitles([page(`${header}\n${a}`), page(`${header}\n${b}`)]);
  titles.forEach(title => {
    assert.ok(title.length <= 80);
    assert.match(title, /^가상 큰 제목/);
    assert.match(title, / — 가상 세부 업무/);
  });
  assert.notEqual(titles[0], titles[1]);
});

test('empty input is supported and invalid inputs fail rather than inventing task contents', () => {
  assert.deepEqual(proposeDraftTitles([]), []);
  assert.throws(() => proposeDraftTitles(null), /배열/);
  assert.throws(() => proposeDraftTitles([{ text: null }]), /문자열/);
});
