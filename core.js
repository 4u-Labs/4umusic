export const STORAGE_KEY = '4umusic:guest:v1';
export const isVideoId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
export const cleanText = (value, limit = 200) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
export function videoIdFrom(value) {
  const input = String(value ?? '').trim();
  if (isVideoId(input)) return input;
  try {
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    else if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      id = url.searchParams.get('v') || (/^\/(embed|shorts|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : null);
    }
    return isVideoId(id) ? id : null;
  } catch { return null; }
}
export function normalizeTrack(track) {
  if (!track || !isVideoId(track.id)) return null;
  return { id: track.id, title: cleanText(track.title || 'Vídeo do YouTube', 240), artist: cleanText(track.artist || 'YouTube', 160), addedAt: Number.isFinite(track.addedAt) ? Math.max(0, track.addedAt) : Date.now() };
}
export function uniqueTracks(tracks, max = 2000) {
  if (!Array.isArray(tracks)) return [];
  const seen = new Set();
  return tracks.slice(0, max).map(normalizeTrack).filter(track => track && !seen.has(track.id) && seen.add(track.id));
}
export function emptyLibrary() { return { schema: 1, favorites: [], playlists: [] }; }
export function normalizeLibrary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arquivo de biblioteca inválido.');
  if (value.schema !== 1) throw new Error('Esta versão do arquivo não é compatível.');
  const ids = new Set();
  const playlists = (Array.isArray(value.playlists) ? value.playlists : []).slice(0, 100).filter(item => item && /^[\w-]{1,80}$/.test(item.id) && !ids.has(item.id) && ids.add(item.id)).map(item => ({ id: item.id, name: cleanText(item.name || 'Minha playlist', 80), tracks: uniqueTracks(item.tracks) }));
  return { schema: 1, favorites: uniqueTracks(value.favorites), playlists };
}
export function mergeLibraries(local, remote) {
  const a = normalizeLibrary(local), b = normalizeLibrary(remote);
  const playlists = b.playlists.map(item => ({ ...item, tracks: [...item.tracks] }));
  for (const list of a.playlists) {
    const match = playlists.find(item => item.id === list.id);
    if (match) match.tracks = uniqueTracks([...match.tracks, ...list.tracks]);
    else playlists.push(list);
  }
  return normalizeLibrary({ schema: 1, favorites: uniqueTracks([...b.favorites, ...a.favorites]), playlists });
}
export function moveItem(items, from, to) {
  const result = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= result.length || to < 0 || to >= result.length) return result;
  result.splice(to, 0, result.splice(from, 1)[0]);
  return result;
}
export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const total = Math.floor(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
export const youtubeUrl = id => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
export const thumbUrl = id => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
export const uid = () => globalThis.crypto?.randomUUID?.() || `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
