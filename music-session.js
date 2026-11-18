import { normalizeTrack, uniqueTracks } from './core.js';

const folded=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const words=value=>folded(value).replace(/[^a-z0-9]+/g,' ').trim();
function artistName(value){return String(value||'').replace(/\s*[-–—]\s*Topic\s*$/i,'').replace(/VEVO|\bOfficial\b|\bOficial\b/gi,'').split(/\s*[·|]\s*|\s+(?:feat\.?|ft\.?)\s+/i)[0].trim();}
export function songIdentity(track){
 let title=String(track?.title||''),artist=artistName(track?.artist);
 const split=title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
 if(split){artist=artistName(split[1]);title=split[2];}
 title=title.replace(/[\[(][^\])]*(?:official|oficial|video|audio|lyric|live|remaster|tradu|legendad|\bhd\b|\bhq\b|\b4k\b)[^\])]*[\])]/gi,'')
  .replace(/\b(?:official|oficial)\s+(?:music\s+)?(?:video|audio)\b|\blyrics?\b|\bremaster(?:ed|izado)?(?:\s+\d{4})?\b/gi,'')
  .replace(/\s+(?:feat\.?|ft\.?)\s+.*$/i,'');
 const name=words(title),owner=words(artist);
 if(!name||/^(video do youtube|youtube|musica)$/.test(name))return 'video:'+track?.id;
 return owner+'|'+name;
}
export function shuffled(tracks,random=Math.random){
 const result=[...tracks];
 for(let i=result.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[result[i],result[j]]=[result[j],result[i]];}
 return result;
}
export function spreadArtists(tracks){
 const pool=[...tracks],result=[];
 while(pool.length){
  const last=artistName(result.at(-1)?.artist).toLocaleLowerCase(),before=artistName(result.at(-2)?.artist).toLocaleLowerCase();
  let index=pool.findIndex(track=>{const artist=artistName(track.artist).toLocaleLowerCase();return artist&&artist!==last&&artist!==before;});
  if(index<0)index=pool.findIndex(track=>artistName(track.artist).toLocaleLowerCase()!==last);
  result.push(pool.splice(Math.max(0,index),1)[0]);
 }
 return result;
}
const unwantedVersion=/\b(?:cover|karaoke|reaction|react|live|ao vivo|legendad[oa]?|tradu[çc][aã]o|tutorial|aula|slowed|sped up|nightcore)\b/i;
export function rankMusicResults(items,query=''){
 const terms=words(query).split(' ').filter(term=>term.length>2&&!["music","musica","video","official","oficial"].includes(term));
 return [...items].map((item,index)=>{
  const title=String(item.title||''),artist=String(item.artist||''),titleWords=words(title),artistWords=words(artist);
  let score=0;
  for(const term of terms){if(titleWords.includes(term))score+=3;else if(artistWords.includes(term))score+=1;}
  if(/\b(?:official|oficial|vevo|topic)\b/i.test(`${title} ${artist}`))score+=5;
  if(/\b(?:official|oficial)\s+(?:music\s+)?(?:video|audio)\b/i.test(title))score+=3;
  if(unwantedVersion.test(title))score-=10;
  if(/\b(?:full album|compilation|playlist|mix|1\s*hour|10\s*hours)\b/i.test(title))score-=4;
  return {item,index,score};
 }).sort((a,b)=>b.score-a.score||a.index-b.index).map(entry=>entry.item);
}
export function isPreferredMusicVideo(item){
 return !unwantedVersion.test(String(item?.title||''))&&/\b(?:official|oficial|vevo|topic)\b/i.test(`${item?.title||''} ${item?.artist||''}`);
}
export function createMusicSession(snapshot={}){
 snapshot=snapshot&&typeof snapshot==='object'?snapshot:{};
 const ids=new Set((Array.isArray(snapshot.ids)?snapshot.ids:[]).filter(id=>typeof id==='string'&&/^[\w-]{11}$/.test(id)).slice(0,10000));
 const songs=new Set((Array.isArray(snapshot.songs)?snapshot.songs:[]).filter(key=>typeof key==='string'&&key.length<=500).slice(0,10000));
 const has=track=>!!track&&(ids.has(track.id)||songs.has(songIdentity(track)));
 return {
  has,
  mark(track){const valid=normalizeTrack(track);if(valid){ids.add(valid.id);songs.add(songIdentity(valid));}},
  unheard(tracks){const batch=new Set();return uniqueTracks(tracks).filter(track=>{const key=songIdentity(track);if(has(track)||batch.has(key))return false;batch.add(key);return true;});},
  clear(){ids.clear();songs.clear();},
  snapshot(){return {ids:[...ids],songs:[...songs]};},
  count(){return ids.size;}
 };
}
export function recommendationQuery(track,context=''){
 const genre=folded(context).match(/\b(bossa nova|mpb|jazz|rock|pop|lo[ -]?fi|eletronica|samba|sertanejo|reggae|hip hop|blues|gospel|forro|funk|classica)\b/)?.[0];
 if(genre)return `${genre} music official`;
 const prefix=String(track?.title||'').match(/^(.+?)\s+[-–—]\s+/)?.[1];
 const artist=artistName(prefix||track?.artist);
 if(artist&&!/^(youtube|musicas?|various artists)$/i.test(artist))return `${artist} music official`.slice(0,200);
 return `${String(track?.title||'música').slice(0,140)} músicas semelhantes`;
}
export function similarStyleQuery(track,context=''){
 if(/\b(mpb|jazz|rock|pop|lo[ -]?fi|eletronica|samba|sertanejo|reggae|hip hop|blues|gospel|forro|funk|classica|bossa nova)\b/.test(folded(context)))return recommendationQuery(track,context);
 const text=folded(`${track?.title||''} ${track?.artist||''} ${context}`);
 const styles=[
  [/(coldplay|radiohead|muse|oasis|arctic monkeys)/,'alternative rock'],
  [/(daft punk|avicii|calvin harris|david guetta)/,'electronic dance'],
  [/(queen|beatles|rolling stones|bon jovi)/,'classic rock'],
  [/(dua lipa|taylor swift|ariana grande|the weeknd)/,'pop'],
  [/(anitta|luisa sonza|pabllo vittar)/,'pop brasileiro'],
  [/(gilberto gil|caetano veloso|marisa monte|elis regina|djavan)/,'mpb'],
  [/(metallica|iron maiden|ac dc|guns n roses)/,'hard rock'],
  [/(bob marley|damian marley)/,'reggae'],
  [/(eminem|kendrick lamar|drake)/,'hip hop']
 ];
 const style=styles.find(([pattern])=>pattern.test(text))?.[1];
 return style?`${style} official music video`:recommendationQuery(track,context);
}
