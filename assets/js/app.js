
const io = new IntersectionObserver((entries)=>{
  entries.forEach(e=>{
    if(e.isIntersecting){e.target.classList.add('show');io.unobserve(e.target);}
  })
},{threshold:.1});
document.querySelectorAll('.reveal').forEach(el=>io.observe(el));
document.querySelectorAll('form[data-demo]').forEach(form=>{
  form.addEventListener('submit',(e)=>{
    e.preventDefault();
    const b=form.querySelector('button[type=submit]');
    b.textContent='Request captured';
    b.disabled=true;
    setTimeout(()=>{b.textContent='Request executive briefing';b.disabled=false},2500);
  });
});
