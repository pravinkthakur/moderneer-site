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
  navToggle.addEventListener('click', () => {
    setMenu(navToggle.getAttribute('aria-expanded') !== 'true');
  });

  navPanel.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setMenu(false));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMenu(false);
  });
}

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener('click', () => {
    const target = link.getAttribute('href');
    if (target && target.length > 1) history.replaceState(null, '', target);
  });
});