// Another app that embeds the studio (docs/design/embedding.md): it imports the package like any dependency and
// mounts it into its own page, talking to a Rideo server on another origin given in the query.
import { mountRideo, type RideoHandle } from '@rideo/web';
import '@rideo/web/style.css';

// The test's options, kept for the session like a host keeps its own configuration.
const given = new URLSearchParams(location.search);
for (const k of ['server', 'routing', 'header']) {
  const v = given.get(k);
  if (v !== null) sessionStorage.setItem(`host.${k}`, v);
}
const q = { get: (k: string) => sessionStorage.getItem(`host.${k}`) };
const studio: RideoHandle = mountRideo(document.getElementById('studio')!, {
  server: q.get('server') ?? '/',
  routing:
    q.get('routing') === 'browser'
      ? { mode: 'browser', basename: '/video' }
      : { mode: (q.get('routing') as 'hash' | 'memory' | null) ?? 'hash' },
  theme: { mode: 'light', colors: { accent: '#7c3aed' }, brand: { name: 'Host Video' } },
  chrome: { header: q.get('header') !== 'off' },
  onNavigate: (path) => {
    document.body.dataset.studioPath = path;
  },
});
(window as unknown as { studio: RideoHandle }).studio = studio;
