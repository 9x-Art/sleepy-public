JSON.stringify({
  sleepy: typeof window.Sleepy,
  regCount: (window.Sleepy && window.Sleepy.registered) ? Object.keys(window.Sleepy.registered()).length : -1,
  homeLen: (function(){ var e=document.querySelector('.page[data-page="home"]'); return e ? e.innerHTML.length : -1; })(),
  homeChildren: (function(){ var e=document.querySelector('.page[data-page="home"]'); return e ? e.children.length : -1; })(),
  navDepth: window.Sleepy && window.Sleepy.nav ? window.Sleepy.nav.depth() : -1,
  stackLen: (function(){ var e=document.getElementById('stack'); return e ? e.children.length : -1; })(),
  errs: (window.__errs || []).length
})
