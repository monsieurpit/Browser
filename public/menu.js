(() => {
  const defaults = [
    ['YouTube', 'https://www.youtube.com', '#dc2626'],
    ['Google', 'https://www.google.com', '#2563eb'],
    ['Spotify', 'https://open.spotify.com', '#16a34a'],
    ['SoundCloud', 'https://soundcloud.com', '#ea580c'],
    ['Wikipedia', 'https://www.wikipedia.org', '#475569'],
    ['Reddit', 'https://www.reddit.com', '#f97316'],
    ['GitHub', 'https://github.com', '#7c3aed'],
    ['Twitch', 'https://www.twitch.tv', '#9333ea'],
  ];
  const KEY = 'menu-shortcuts';
  const $ = (s) => document.querySelector(s);
  const launch = (url) => `/app/?go=${encodeURIComponent(url)}`;
  const normalize = (v) => {
    v = v.trim();
    if (!v) return '';
    if (v.includes('://')) return v;
    if (!v.includes(' ') && v.includes('.')) return `https://${v}`;
    return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
  };
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const save = (list) => localStorage.setItem(KEY, JSON.stringify(list));

  function tile(name, url, color, onRemove) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'tile';
    a.href = launch(url);
    const ico = document.createElement('div');
    ico.className = 'ico';
    ico.style.background = color;
    ico.textContent = name[0].toUpperCase();
    const label = document.createElement('span');
    label.textContent = name;
    a.append(ico, label);
    li.append(a);
    if (onRemove) {
      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.type = 'button';
      rm.title = 'Remove';
      rm.textContent = '×';
      rm.addEventListener('click', onRemove);
      li.append(rm);
    }
    return li;
  }

  function render() {
    $('#shortcuts').replaceChildren(...defaults.map(([n, u, c]) => tile(n, u, c)));
    const list = load();
    $('#custom').replaceChildren(...(list.length
      ? list.map((item, i) => tile(item.name, item.url, '#0891b2', () => { list.splice(i, 1); save(list); render(); }))
      : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No shortcuts yet. Use + Add.' })]));
  }

  $('#go').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = normalize($('#q').value);
    if (url) location.assign(launch(url));
  });
  $('#add').addEventListener('click', () => {
    const raw = prompt('Website address');
    const url = raw && normalize(raw);
    if (!url || !url.includes('://')) return;
    let name = url;
    try { name = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    const list = load();
    list.push({ name, url });
    save(list.slice(-24));
    render();
  });
  $('#logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    location.assign('/login');
  });
  fetch('/health').then((r) => r.json()).then((d) => { $('#health').textContent = d.status; })
    .catch(() => { $('#health').textContent = 'offline'; });
  render();
})();
