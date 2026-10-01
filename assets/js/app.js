const revealObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('show');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 })
  : null;

document.querySelectorAll('.reveal').forEach((element) => {
  if (revealObserver) revealObserver.observe(element);
  else element.classList.add('show');
});

const navToggle = document.querySelector('[data-nav-toggle]');
const navPanel = document.querySelector('[data-nav-panel]');
function setMenu(open) {
  if (!navToggle || !navPanel) return;
  navToggle.setAttribute('aria-expanded', String(open));
  navPanel.hidden = !open;
  document.body.classList.toggle('menu-open', open);
}
if (navToggle && navPanel) {
  navToggle.addEventListener('click', () => setMenu(navToggle.getAttribute('aria-expanded') !== 'true'));
  navPanel.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false); });
}

const journeyButtons = [...document.querySelectorAll('[data-journey]')];
const journeyPanels = [...document.querySelectorAll('[data-journey-panel]')];
journeyButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const id = button.dataset.journey;
    journeyButtons.forEach((b) => b.classList.toggle('active', b === button));
    journeyPanels.forEach((p) => p.classList.toggle('active', p.dataset.journeyPanel === id));
  });
});

const cases = {
  growth: {
    question: 'Should we accelerate expansion into Market X or phase the investment?',
    audience: 'CEO · CFO · COO · 12-month horizon',
    signals: 'Salesforce pipeline · customer feedback · financial assumptions · operational capacity · supplier exposure · competitive intelligence',
    gap: 'Operational readiness in the new market is not yet evidenced strongly enough.',
    readiness: 'Needs validation',
    next: 'Validate fulfilment capacity and unit economics before committing to full acceleration.'
  },
  technology: {
    question: 'Should we modernise the platform now or phase the investment?',
    audience: 'CTO · CIO · CFO · 18-month horizon',
    signals: 'Architecture findings · source control · delivery flow · incidents · observability · cloud cost · roadmap dependencies',
    gap: 'Migration complexity and transition risk remain insufficiently quantified.',
    readiness: 'Needs validation',
    next: 'Validate migration scope and sequencing before committing to full-scale modernisation.'
  }
};
document.querySelectorAll('[data-case]').forEach((button) => {
  button.addEventListener('click', () => {
    const data = cases[button.dataset.case];
    if (!data) return;
    document.querySelectorAll('[data-case]').forEach((b) => {
      b.classList.toggle('active', b === button);
      b.setAttribute('aria-selected', String(b === button));
    });
    const mapping = {
      '[data-case-question]': data.question,
      '[data-case-audience]': data.audience,
      '[data-case-signals]': data.signals,
      '[data-case-gap]': data.gap,
      '[data-case-readiness]': data.readiness,
      '[data-case-next]': data.next
    };
    Object.entries(mapping).forEach(([selector, value]) => {
      const el = document.querySelector(selector);
      if (el) el.textContent = value;
    });
  });
});

const chapterLinks = [...document.querySelectorAll('[data-chapter-link]')];
const chapters = [...document.querySelectorAll('[data-chapter]')];
if ('IntersectionObserver' in window && chapterLinks.length && chapters.length) {
  const chapterObserver = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    const id = visible.target.dataset.chapter;
    chapterLinks.forEach((link) => link.classList.toggle('active', link.dataset.chapterLink === id));
  }, { rootMargin: '-35% 0px -50% 0px', threshold: [0, .2, .5, .8] });
  chapters.forEach((chapter) => chapterObserver.observe(chapter));
}