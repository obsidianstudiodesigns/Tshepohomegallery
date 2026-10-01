import { works } from './works.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const WHATSAPP = '27612568194';
const waLink = (text) => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;

$('#year').textContent = new Date().getFullYear();

/* ---------- top bar colour follows the section under it ---------- */
const bar = $('.bar');
const walk = $('#walk');
new IntersectionObserver(([e]) => bar.classList.toggle('on-paper', !e.isIntersecting), { rootMargin: '0px 0px -100% 0px' }).observe(walk);

/* ---------- gallery walk ---------- */
const intro = $('#intro');
const label = $('#label');
const walkEnd = $('#walk-end');
const fill = $('#progress-fill');
const loading = $('#loading');
let gallery = null;

function walkProgress() {
  const r = walk.getBoundingClientRect();
  const total = r.height - innerHeight;
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, -r.top / total));
}

function onScroll() {
  const p = walkProgress();
  fill.style.transform = `scaleX(${p})`;
  // the title steps aside as soon as the walk begins
  intro.style.opacity = String(Math.max(0, 1 - p * 14));
  if (gallery) gallery.setProgress(p);
}

function showStation(i, stage) {
  walkEnd.classList.toggle('show', stage === 'end');
  if (i === null) { label.classList.remove('show'); return; }
  const w = works[i];
  $('#label-title').textContent = w.title;
  $('#label-medium').textContent = w.medium;
  $('#label-ask').href = waLink(`Hi Tshepo, I saw "${w.title}" on your website and I'd like to know more about it.`);
  label.classList.add('show');
}

async function startGallery() {
  const canvas = $('#gallery');
  const test = document.createElement('canvas');
  if (!(test.getContext('webgl2') || test.getContext('webgl'))) return fallback();
  try {
    const { initGallery } = await import('./gallery3d.js');
    gallery = initGallery({
      canvas,
      works,
      onLoadProgress: (k) => { $('#loading-pct').textContent = ` ${Math.round(k * 100)}%`; },
      onReady: () => loading.classList.add('done'),
      onStation: showStation,
      onPick: openLightbox,
    });
    if (!gallery) return fallback();
    gallery.setProgress(walkProgress());
    // stop rendering while the walk is off screen
    new IntersectionObserver(([e]) => (e.isIntersecting ? gallery.resume() : gallery.pause())).observe(walk);
  } catch (err) {
    console.error(err);
    fallback();
  }
}

function fallback() {
  $('#gallery').hidden = true;
  $('.stage-fallback').hidden = false;
  loading.classList.add('done');
  walk.style.height = '100vh';
}

addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
onScroll();
addEventListener('load', onScroll);
startGallery();

/* ---------- surfaces ---------- */
const surfImg = $('#surface-img');
const surfNote = $('#surface-note');
function pickSurface(btn) {
  $$('.surface').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  if (btn.dataset.note) {
    surfNote.textContent = btn.dataset.note;
    surfNote.hidden = false;
    return;
  }
  surfNote.hidden = true;
  if (surfImg.getAttribute('src') === btn.dataset.img) return;
  surfImg.classList.add('swap');
  const next = new Image();
  next.src = btn.dataset.img;
  next.decode().catch(() => {}).then(() => {
    surfImg.src = btn.dataset.img;
    surfImg.alt = btn.dataset.alt;
    surfImg.classList.remove('swap');
  });
}
$$('.surface').forEach((b) => {
  b.addEventListener('click', () => pickSurface(b));
  b.addEventListener('mouseenter', () => matchMedia('(hover: hover)').matches && pickSurface(b));
});

/* ---------- collection ---------- */
const list = $('#works');
works.forEach((w, i) => {
  const li = document.createElement('li');
  li.className = 'work';
  li.dataset.kind = w.kind;
  li.innerHTML = `
    <button type="button" aria-label="View ${w.title} larger">
      <span class="work-img"><img src="${w.src}" alt="${w.alt}" loading="lazy" decoding="async"></span>
      <span class="work-cap"><strong>${w.title}</strong><span>${w.medium}</span></span>
    </button>`;
  li.querySelector('button').addEventListener('click', () => openLightbox(i));
  list.appendChild(li);
});

$$('.filter').forEach((f) => f.addEventListener('click', () => {
  $$('.filter').forEach((x) => x.setAttribute('aria-pressed', String(x === f)));
  const k = f.dataset.filter;
  $$('.work').forEach((li) => { li.hidden = k !== 'all' && li.dataset.kind !== k; });
}));

/* ---------- lightbox ---------- */
const lb = $('#lightbox');
let lbIndex = 0;
function renderLightbox() {
  const w = works[lbIndex];
  $('#lb-img').src = w.src;
  $('#lb-img').alt = w.alt;
  $('#lb-title').textContent = w.title;
  $('#lb-medium').textContent = w.medium;
}
function openLightbox(i) {
  lbIndex = i;
  renderLightbox();
  if (!lb.open) lb.showModal();
}
const step = (d) => { lbIndex = (lbIndex + d + works.length) % works.length; renderLightbox(); };
$('#lb-prev').addEventListener('click', () => step(-1));
$('#lb-next').addEventListener('click', () => step(1));
$('#lb-close').addEventListener('click', () => lb.close());
lb.addEventListener('click', (e) => { if (e.target === lb) lb.close(); });
lb.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

/* ---------- commission brief → WhatsApp ---------- */
$('#brief').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget.elements;
  const name = f.name.value.trim();
  const err = $('#form-error');
  if (!name) {
    err.hidden = false;
    f.name.focus();
    return;
  }
  err.hidden = true;
  const text = `Hi Tshepo, I'm ${name}. I'd like to commission: ${f.surface.value}.${f.msg.value.trim() ? `\n\n${f.msg.value.trim()}` : ''}`;
  window.open(waLink(text), '_blank', 'noopener');
});
