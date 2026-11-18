import { STORAGE_KEY, videoIdFrom, normalizeTrack, normalizeLibrary, emptyLibrary, mergeLibraries, uniqueTracks, moveItem, formatTime, youtubeUrl, thumbUrl, uid, cleanText } from './core.js';
import { createMusicSession, shuffled, spreadArtists, recommendationQuery, similarStyleQuery, rankMusicResults, isPreferredMusicVideo } from './music-session.js?v=20261013-4';
import { createScreenWakeLock } from './screen-wake-lock.js?v=20261012-4';

const $ = selector => document.querySelector(selector);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const catalog = [
 {id:'5NV6Rdv1a3I',title:'Get Lucky (Official Audio)',artist:'Daft Punk · Pharrell Williams · Nile Rodgers'},
 {id:'1G4isv_Fylg',title:'Paradise (Official Video)',artist:'Coldplay'},
 {id:'djV11Xbc914',title:'Take On Me (Official Video)',artist:'a-ha'},
 {id:'TUVcZfQe-Kw',title:'Levitating ft. DaBaby (Official Music Video)',artist:'Dua Lipa'},
 {id:'fJ9rUzIMcZQ',title:'Bohemian Rhapsody (Official Video Remastered)',artist:'Queen Official'},
 {id:'kJQP7kiw5Fk',title:'Despacito ft. Daddy Yankee',artist:'Luis Fonsi'}
].map(normalizeTrack);
const mixes = [
 {name:'Modo foco',subtitle:'Uma pausa no ruído.',ink:'#d3eeb9',bg:'#304332',display:'Modo<br>foco.',query:'instrumental lo fi music'},
 {name:'Volume alto',subtitle:'Energia para o seu dia.',ink:'#e0d2ff',bg:'#5b427c',display:'Volume<br>alto.',query:'rock official music video'},
 {name:'Sol brasileiro',subtitle:'Um encontro com a MPB.',ink:'#f4d4a0',bg:'#8c5932',display:'Sol<br>brasileiro.',query:'MPB música vídeo oficial'}
];
let storageOK = true, user = null, config = { searchEnabled:false, authMode:'local' }, version = 0, accountEpoch = 0, syncTimer, syncPaused = false, revision = 0, syncing = false, searchController, searchSeq = 0;
let library = readLibrary(STORAGE_KEY), view = 'home', selectedPlaylist = null, searchQuery = '', searchKind = 'video', searchResults = [], nextPage = '', remotePlaylist = null;
let selectedArtist=null,artistTracks=[],artistPage='',artistLoading=false,artistAlbums=[];
let queue = [], currentIndex = -1, player, playerReady = false, playerLoading = false, playing = false, autoRadio = true, shuffle = true, muted = false, ytTimer, uiTimer;
let keepScreenOn=false, previousWakeStatus='';
try{keepScreenOn=localStorage.getItem('4umusic:keep-awake:v1')==='true';}catch{}
const screenWakeLock=createScreenWakeLock({wakeLock:navigator.wakeLock,enabled:keepScreenOn,onChange:renderScreenWakeLock});
void screenWakeLock.setVisible(!document.hidden);
let selectionTrack = null, draggingIndex = null, installPrompt = null;
let installationPending=false, installedThisSession=false;
let savedSession={};try{savedSession=JSON.parse(sessionStorage.getItem('4umusic:session:v1')||'{}');}catch{}
const musicSession=createMusicSession(savedSession);
let queueEpoch=0, transportEpoch=0, desiredPlayback=false, radioTask=null, radioController=null, radioSeed=null, radioContext='', radioError='', nextOperation=null, consecutiveFailures=0;
const radioPages=new Map(),radioAdded=new Set();
let visibilityTimer, layoutSettlingUntil=0, seekInteracting=false;
const QUEUE_KEY='4umusic:queue:v2', HISTORY_KEY='4umusic:history:v1', TASTE_KEY='4umusic:taste:v1', SEARCH_KEY='4umusic:searches:v1';
let listeningTimer=null,listeningBusy=false,listeningRevision=0,suspendListening=false;
const readJSON=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||'null')??fallback;}catch{return fallback;}};
let recentTracks=uniqueTracks(readJSON(HISTORY_KEY,[])).slice(0,30);
let recentSearches=readJSON(SEARCH_KEY,[]);if(!Array.isArray(recentSearches))recentSearches=[];
let taste=readJSON(TASTE_KEY,{disliked:[],skipped:[]});
if(!Array.isArray(taste.disliked)||!Array.isArray(taste.skipped))taste={disliked:[],skipped:[]};
let libraryFilter='',playlistFilter='',librarySort='manual',selectedTracks=new Set(),searchFilter='all',mixMode='varied';
let sleepTimer=null,sleepAtEnd=false,sleepUntil=0,resumeSeconds=0,resumeStart=0;
let remotePlaylistPage='',remotePlaylistSource='',remotePlaylistLoading=false;
try{const restored=JSON.parse(sessionStorage.getItem(QUEUE_KEY)||'null');if(restored&&Array.isArray(restored.queue)){
 queue=uniqueTracks(restored.queue).slice(0,2000);currentIndex=Math.min(queue.length-1,Math.max(-1,Number(restored.index)||0));
 resumeSeconds=Math.max(0,Math.min(86400,Number(restored.seconds)||0));radioSeed=normalizeTrack(restored.seed)||queue[currentIndex]||null;
 radioContext=cleanText(restored.context||'',100);autoRadio=restored.autoRadio!==false;shuffle=restored.shuffle!==false;
}}catch{}
function listeningKey(){return user?`4umusic:account:${user.id}:listening:v1`:'4umusic:guest:listening:v1';}
function listeningSnapshot(){return {recent:recentTracks.slice(0,30),searches:recentSearches.slice(0,8),disliked:taste.disliked.slice(0,200),skipped:taste.skipped.slice(0,200),queue:queue.slice(0,200),index:currentIndex,seconds:resumeSeconds,seed:radioSeed,context:radioContext,autoRadio,shuffle,mixMode};}
function persistListening(delay=12000){
 if(suspendListening)return;
 try{localStorage.setItem(listeningKey(),JSON.stringify({updatedAt:Date.now(),data:listeningSnapshot()}));}catch{}
 if(!user||config.authMode!=='google')return;
 listeningRevision++;if(!listeningTimer)listeningTimer=setTimeout(()=>{listeningTimer=null;void syncListening();},delay);
}
async function syncListening(){
 if(!user||listeningBusy||config.authMode!=='google')return;
 const owner=user.id,revision=listeningRevision;listeningBusy=true;
 try{await api('listening',{method:'PUT',body:{listening:listeningSnapshot()}});if(user?.id===owner&&listeningRevision!==revision&&!listeningTimer)listeningTimer=setTimeout(()=>{listeningTimer=null;void syncListening();},1500);}
 catch{if(user?.id===owner&&!listeningTimer)listeningTimer=setTimeout(()=>{listeningTimer=null;void syncListening();},30000);}
 finally{listeningBusy=false;}
}
function applyListening(value,{keepPlayback=false}={}){
 if(!value||typeof value!=='object')return;
 suspendListening=true;
 recentTracks=uniqueTracks(value.recent).slice(0,30);
 recentSearches=Array.isArray(value.searches)?value.searches.filter(item=>typeof item==='string').slice(0,8):[];
 taste={disliked:Array.isArray(value.disliked)?value.disliked.slice(0,200):[],skipped:Array.isArray(value.skipped)?value.skipped.slice(0,200):[]};
 mixMode=['similar','varied','discovery'].includes(value.mixMode)?value.mixMode:'varied';
 if(!keepPlayback){queue=uniqueTracks(value.queue).slice(0,200);currentIndex=Math.max(-1,Math.min(queue.length-1,Number(value.index)||0));resumeSeconds=Math.max(0,Math.min(86400,Number(value.seconds)||0));radioSeed=normalizeTrack(value.seed)||queue[currentIndex]||null;radioContext=cleanText(value.context||'',100);autoRadio=value.autoRadio!==false;shuffle=value.shuffle!==false;musicSession.clear();if(currentTrack())musicSession.mark(currentTrack());saveMusicSession();try{sessionStorage.setItem(user?QUEUE_KEY+':'+user.id:QUEUE_KEY,JSON.stringify({queue,index:currentIndex,seconds:resumeSeconds,seed:radioSeed,context:radioContext,autoRadio,shuffle}));}catch{}}
 suspendListening=false;renderPage();updateNow();renderQueue();
}
function hydrateListening(remote,updatedAt){
 let local=null;try{local=JSON.parse(localStorage.getItem(listeningKey())||'null');}catch{}
 if(local?.data&&Number(local.updatedAt)>Number(updatedAt||0)){applyListening(local.data,{keepPlayback:playing});persistListening(1500);}
 else if(remote)applyListening(remote,{keepPlayback:playing});
 else if(!local)persistListening(1500);
}
function restoreGuestListening(){
 let saved=null;try{saved=JSON.parse(localStorage.getItem('4umusic:guest:listening:v1')||'null')?.data;}catch{}
 if(!saved){let oldQueue={};try{oldQueue=JSON.parse(sessionStorage.getItem(QUEUE_KEY)||'{}');}catch{}saved={recent:readJSON(HISTORY_KEY,[]),searches:readJSON(SEARCH_KEY,[]),...readJSON(TASTE_KEY,{disliked:[],skipped:[]}),...oldQueue,mixMode:'varied'};}
 applyListening(saved);
}
function saveQueue(){try{sessionStorage.setItem(user?QUEUE_KEY+':'+user.id:QUEUE_KEY,JSON.stringify({queue:queue.slice(0,2000),index:currentIndex,seconds:resumeSeconds,seed:radioSeed,context:radioContext,autoRadio,shuffle}));}catch{}persistListening();}
function rememberTrack(track){recentTracks=uniqueTracks([track,...recentTracks]).slice(0,30);if(!user)try{localStorage.setItem(HISTORY_KEY,JSON.stringify(recentTracks));}catch{}persistListening(1500);}
function rememberSearch(query){recentSearches=[query,...recentSearches.filter(item=>item!==query)].slice(0,8);if(!user)try{localStorage.setItem(SEARCH_KEY,JSON.stringify(recentSearches));}catch{}persistListening(1500);}
function rememberTaste(kind,id){taste[kind]=[id,...taste[kind].filter(value=>value!==id)].slice(0,200);if(!user)try{localStorage.setItem(TASTE_KEY,JSON.stringify(taste));}catch{}persistListening(1500);}
function sortAndFilter(tracks){const value=libraryFilter.toLocaleLowerCase('pt-BR');let found=tracks.filter(track=>`${track.title} ${track.artist}`.toLocaleLowerCase('pt-BR').includes(value));if(librarySort==='title')found=[...found].sort((a,b)=>a.title.localeCompare(b.title,'pt-BR'));if(librarySort==='artist')found=[...found].sort((a,b)=>a.artist.localeCompare(b.artist,'pt-BR'));if(librarySort==='recent')found=[...found].sort((a,b)=>b.addedAt-a.addedAt);return found;}
function libraryTools(){return `<div class="library-tools"><input id="library-filter" class="form-input" type="search" placeholder="Buscar nesta lista" value="${escape(libraryFilter)}" aria-label="Buscar nesta lista"><select id="library-sort" class="form-input" aria-label="Ordenar músicas"><option value="manual" ${librarySort==='manual'?'selected':''}>Minha ordem</option><option value="title" ${librarySort==='title'?'selected':''}>Título</option><option value="artist" ${librarySort==='artist'?'selected':''}>Artista</option><option value="recent" ${librarySort==='recent'?'selected':''}>Adicionadas recentemente</option></select><button class="button button-quiet" data-action="remove-selected" ${selectedTracks.size?'':'disabled'}>Remover selecionadas (${selectedTracks.size})</button></div>`;}
function restoreRemoved(current,previous,ids){const result=[...current];previous.forEach((track,index)=>{if(ids.has(track.id)&&!result.some(item=>item.id===track.id))result.splice(Math.min(index,result.length),0,track);});return result;}

const standaloneMode=window.matchMedia('(display-mode: standalone)');
try { const prefs = JSON.parse(localStorage.getItem('4umusic:player:v1') || '{}'); $('#volume').value = Math.min(100, Math.max(0, Number(prefs.volume) || 70)); } catch {}
function renderScreenWakeLock(state){
 const labels={off:'Manter tela ligada',active:'Tela ligada · ativa',pending:'Tela ligada · ativando',paused:'Tela ligada · ao tocar',hidden:'Tela ligada · ao tocar',blocked:'Tela ligada · bloqueada',unsupported:'Tela ligada indisponível'};
 const descriptions={off:'Ative para evitar o bloqueio automático da tela enquanto a música toca.',active:'Tela mantida ligada durante a reprodução. Toque para desativar.',pending:'Solicitando ao navegador que mantenha a tela ligada.',paused:'Opção ativada. A tela será mantida ligada quando a música tocar com o app visível. Toque para desativar.',hidden:'A tela só pode ser mantida ligada com o app visível. Toque para desativar.',blocked:'O navegador ou o sistema liberou ou bloqueou a tela ligada. Desative e ative novamente para tentar. Verifique a economia de bateria.',unsupported:'Este navegador não oferece a função de manter a tela ligada. Use o ajuste de tempo de tela do celular.'};
 const button=$('#wake-toggle');button.disabled=!state.supported;button.dataset.state=state.status;button.setAttribute('aria-pressed',String(state.enabled&&state.supported));button.title=descriptions[state.status];
 $('#wake-label').textContent=labels[state.status];$('#wake-status').textContent=descriptions[state.status];
 if(state.status==='blocked'&&previousWakeStatus!=='blocked')toast('Não foi possível manter a tela ligada. Verifique a economia de bateria ou desative e ative a opção para tentar novamente.');
 previousWakeStatus=state.status;
}
function storageKey(){ return user ? `4umusic:account:${user.id}:v1` : STORAGE_KEY; }
function readLibrary(key){ try { const value = localStorage.getItem(key); return value ? normalizeLibrary(JSON.parse(value)) : emptyLibrary(); } catch { storageOK = false; return emptyLibrary(); } }
function toast(message,actionLabel='',action=null){const el=$('#toast');el.replaceChildren(document.createTextNode(message));if(action){const button=document.createElement('button');button.type='button';button.textContent=actionLabel;button.className='toast-action';button.onclick=()=>{action();el.classList.remove('show');};el.append(button);}el.classList.add('show');clearTimeout(el.timer);el.timer=setTimeout(()=>el.classList.remove('show'),action?8500:3600);}
function saveLibrary(){
 revision++;
 try { localStorage.setItem(storageKey(), JSON.stringify(library));if(user)localStorage.setItem(storageKey()+':sync',JSON.stringify({dirty:true,version}));storageOK=true; } catch {storageOK=false;toast('Não foi possível salvar no navegador. Exporte sua biblioteca para preservá-la.');}
 renderSidebar();updateFavorites();
 if(user && config.authMode==='google' && !syncPaused){$('#save-status').textContent='Alterações a sincronizar';clearTimeout(syncTimer);syncTimer=setTimeout(syncLibrary,900);}
 else $('#save-status').textContent=storageOK?'Salvo neste navegador':'Armazenamento indisponível';
}
async function api(action, options={}){
 const url=new URL('api.php',location.href);url.searchParams.set('action',action);
 for(const [key,value] of Object.entries(options.query||{})) if(value!==undefined && value!=='') url.searchParams.set(key,value);
 const response=await fetch(url,{method:options.method||'GET',credentials:'same-origin',signal:options.signal,headers:options.body?{'Content-Type':'application/json','X-4u-CSRF':config.csrf||''}:{},body:options.body?JSON.stringify(options.body):undefined});
 let data;try{data=await response.json();}catch{throw new Error('O serviço não está disponível nesta hospedagem. Abra a ajuda para configurar.');}
 if(!response.ok){const error=new Error(data.message||'Não foi possível concluir. Tente novamente.');error.code=data.code;error.status=response.status;throw error;}
 return data;
}
function getTrack(id){return [selectionTrack,...catalog,...searchResults,...artistTracks,...queue,...library.favorites,...library.playlists.flatMap(list=>list.tracks),...(remotePlaylist?.tracks||[])].find(track=>track?.id===id);}
function currentTrack(){return queue[currentIndex]||null;}
function isFavorite(id){return library.favorites.some(track=>track.id===id);}
function toggleFavorite(track){if(!track)return;const index=library.favorites.findIndex(item=>item.id===track.id);if(index>=0)library.favorites.splice(index,1);else library.favorites.unshift(normalizeTrack(track));saveLibrary();if(view==='favorites')renderPage();else renderFavoriteButtons();if(index>=0)toast('Removida das favoritas','Desfazer',()=>{if(!isFavorite(track.id)){library.favorites.splice(Math.min(index,library.favorites.length),0,track);saveLibrary();renderPage();}});else toast('Salva nas favoritas');}
function updateFavorites(){const track=currentTrack();for(const id of ['now-favorite','bar-favorite']){const el=$(`#${id}`);el.disabled=!track;el.classList.toggle('active',!!track&&isFavorite(track.id));el.setAttribute('aria-label',track&&isFavorite(track.id)?'Remover música das favoritas':'Favoritar música atual');el.setAttribute('aria-pressed',String(!!track&&isFavorite(track.id)));}renderFavoriteButtons();}
function renderFavoriteButtons(){document.querySelectorAll('[data-action="favorite-track"]').forEach(el=>{const active=isFavorite(el.dataset.id);el.classList.toggle('active',active);el.setAttribute('aria-label',active?'Remover das favoritas':'Favoritar música');el.setAttribute('aria-pressed',String(active));});}
function renderSidebar(){
 $('#favorite-count').textContent=library.favorites.length;
 $('#sidebar-playlists').innerHTML=library.playlists.length?library.playlists.map(list=>`<button class="playlist-nav ${view==='playlist'&&selectedPlaylist===list.id?'active':''}" data-action="open-playlist" data-id="${escape(list.id)}"><span class="mini-cover">${icon('list')}</span><span>${escape(list.name)}</span></button>`).join(''):'<p class="sidebar-footer">Seus melhores encontros musicais,<br>organizados por você.</p>';
 document.querySelectorAll('[data-view]').forEach(el=>{el.classList.toggle('active',el.dataset.view===view);if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
}
function heading(kicker,title,description='',extra=''){return `<div class="page-heading"><div><span class="eyebrow">${escape(kicker)}</span><h1>${escape(title)}</h1>${description?`<p>${escape(description)}</p>`:''}</div>${extra}</div>`;}
function empty(title,description,action='add-link',label='Adicionar uma música',symbol='list'){return `<div class="empty-state">${icon(symbol)}<h2>${escape(title)}</h2><p>${escape(description)}</p><button class="button button-primary" data-action="${escape(action)}">${icon('plus')}${escape(label)}</button></div>`;}
function trackRows(tracks,{reorder=false,remove=false,listId='',select=false}={}){
 return `<div class="track-list">${tracks.map((track,index)=>`<article class="track-row ${currentTrack()?.id===track.id?'active':''}" ${reorder?`draggable="true" data-drag-index="${index}" data-list="${escape(listId)}"`:''}>${select?`<input type="checkbox" class="track-select" data-action="select-track" data-id="${track.id}" aria-label="Selecionar ${escape(track.title)}" ${selectedTracks.has(track.id)?'checked':''}>`:`<span class="track-number">${String(index+1).padStart(2,'0')}</span>`}<img class="track-image" src="${thumbUrl(track.id)}" alt="Miniatura do vídeo ${escape(track.title)}" loading="lazy"><button class="track-title-button" data-action="play-track" data-id="${track.id}" aria-label="Reproduzir ${escape(track.title)}"><strong>${escape(track.title)}</strong><span>${escape(track.artist)}</span></button><a class="track-source" href="${youtubeUrl(track.id)}" target="_blank" rel="noopener noreferrer" aria-label="Abrir ${escape(track.title)} no YouTube">YouTube ↗</a><button class="icon-button track-play" data-action="play-track" data-id="${track.id}" aria-label="Reproduzir ${escape(track.title)}">${icon('play')}</button><button class="icon-button ${isFavorite(track.id)?'active':''}" data-action="favorite-track" data-id="${track.id}" aria-label="Favoritar música" aria-pressed="${isFavorite(track.id)}">${icon('heart')}</button><button class="icon-button" data-action="track-options" data-id="${track.id}" aria-label="Mais opções para ${escape(track.title)}">${icon('dots')}</button>${reorder?`<button class="icon-button" data-action="move-up" data-index="${index}" data-list="${escape(listId)}" aria-label="Mover ${escape(track.title)} para cima" ${index===0?'disabled':''}>${icon('up')}</button><button class="icon-button" data-action="move-down" data-index="${index}" data-list="${escape(listId)}" aria-label="Mover ${escape(track.title)} para baixo" ${index===tracks.length-1?'disabled':''}>${icon('down')}</button>`:''}${remove?`<button class="icon-button" data-action="remove-track" data-id="${track.id}" data-list="${escape(listId)}" aria-label="Remover da playlist">${icon('close')}</button>`:''}</article>`).join('')}</div>`;
}
function homePage(){
 const date=new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'short'}).format(new Date());
 const resume=queue.length&&currentTrack()?`<section class="continue-card"><img src="${thumbUrl(currentTrack().id)}" alt=""><div><strong>Continue ouvindo</strong><span>${escape(currentTrack().title)} · ${escape(currentTrack().artist)}</span></div><button class="button button-primary" data-action="resume">${icon('play')}Continuar</button></section>`:'';
 const personal=recentTracks.length?`<section class="personal-section"><div class="section-heading"><h2>Ouvidas recentemente</h2></div>${trackRows(recentTracks.slice(0,5))}</section>`:'';
 const saved=library.playlists.length?`<section class="personal-section"><div class="section-heading"><h2>Suas playlists</h2></div><div class="library-grid">${library.playlists.slice(0,3).map(list=>`<button class="library-card" data-action="open-playlist" data-id="${escape(list.id)}"><strong>${escape(list.name)}</strong><span>${list.tracks.length} músicas</span></button>`).join('')}</div></section>`:'';
 const artists=[...new Set([...library.favorites,...recentTracks].map(track=>track.artist.replace(/\s*[-–—]\s*Topic$/i,'').replace(/\b(?:VEVO|Official|Oficial)\b/gi,'').split(/[·|]/)[0].trim()).filter(name=>name&&!/^(youtube|various artists)$/i.test(name)))].slice(0,6);
 const artistSection=artists.length?`<section class="personal-section"><div class="section-heading"><h2>Artistas para você</h2></div><div class="artist-chips">${artists.map(name=>`<button class="artist-chip" data-action="artist-lookup" data-name="${escape(name)}">${escape(name)} <span>↗</span></button>`).join('')}</div></section>`:'';
 const moodSection=recentTracks.length?`<section class="personal-section"><div class="section-heading"><h2>Seu mix</h2><button class="text-button" data-action="show-player">Ver fila ↗</button></div><div class="mix-controls">${[['similar','Mais parecidas'],['varied','Variar artistas'],['discovery','Descobrir novidades']].map(([mode,label])=>`<button class="chip ${mixMode===mode?'active':''}" data-action="mix-mode" data-mode="${mode}" aria-pressed="${mixMode===mode}">${label}</button>`).join('')}</div><p class="search-result-note">Ajusta as próximas sugestões; não repete músicas desta sessão.</p></section>`:'';
 return resume+moodSection+artistSection+personal+saved+heading('UM BOM DIA COMEÇA COM UM PLAY','Encontre sua próxima favorita.','Música boa merece um lugar só seu.',`<span class="page-date">${escape(date)} <span class="muted">· seu ritmo</span></span>`)+
 `<section class="hero"><div class="hero-copy"><span class="eyebrow">SUA TRILHA SONORA, DO SEU JEITO</span><h2>Seu som.<br>Seu espaço.</h2><p><span class="hero-description">Descubra músicas, guarde seus encontros<br>e dê play no que faz você sentir.</span><span class="hero-caption">Descubra. Salve. Dê play.</span></p><button class="button" data-action="discover">Explorar músicas ${icon('arrow')}</button></div><div class="hero-art" aria-hidden="true"><div class="orbit"></div><div class="vinyl"></div><div class="vinyl-label">4U MUSIC<br>SIDE A</div></div><span class="hero-star" aria-hidden="true">✳</span><span class="hero-sticker">MADE FOR YOUR EARS</span></section>`+
 `<div class="quick-actions" aria-label="Explorar por gênero">${['Tudo','MPB','Pop','Rock','Jazz','Eletrônica'].map((genre,index)=>`<button class="chip ${index===0?'active':''}" data-action="genre" data-query="${escape(genre)}">${escape(genre)}</button>`).join('')}</div>`+
 `<section><div class="section-heading"><div><h2>Um clima para cada momento</h2><p>Escolha um caminho. Encontre o seu som.</p></div></div><div class="mix-grid">${mixes.map((mix,index)=>`<button class="mix-card" data-action="mix" data-index="${index}" aria-label="Buscar ${escape(mix.name)}"><div class="mix-art" style="--mix-bg:${mix.bg};--mix-ink:${mix.ink}"><span class="mix-number">4U SELECTS / 0${index+1}</span><span class="mix-name">${mix.display}</span><span class="mix-play">${icon('arrow')}</span></div><strong>${escape(mix.name)}</strong><span>${escape(mix.subtitle)}</span></button>`).join('')}</div></section>`+
 `<section><div class="section-heading"><div><h2>Um play para começar</h2><p>Seleção editorial · vídeos de canais oficiais no YouTube</p></div><button class="text-button" data-action="queue-catalog">Ouvir seleção ↗</button></div>${trackRows(catalog.slice(0,5))}</section>`+
 `<div class="mini-banner">${icon('link')}<div><strong>Achou uma música no YouTube?</strong><p>Cole o link e transforme em parte da sua playlist.</p></div><button class="text-button" data-action="add-link">Adicionar ↗</button></div>`;
}
function renderPage(){
 renderSidebar();
 document.documentElement.classList.toggle('returning-listener',recentTracks.length>0);
 const root=$('#page-content');
 if(view==='home')root.innerHTML=homePage();
 else if(view==='favorites')root.innerHTML=heading('GUARDE O QUE TE MOVE','Suas favoritas',`${library.favorites.length} músicas que merecem outro play.`)+(library.favorites.length?`<div class="page-tools"><button class="button button-primary" data-action="play-favorites">${icon('play')}Ouvir favoritas</button><button class="button button-secondary" data-action="add-link">${icon('plus')}Adicionar música</button></div>${libraryTools()}${trackRows(sortAndFilter(library.favorites),{select:true})}`:empty('As favoritas começam com um coração','Toque no coração de uma música para encontrá-la sempre aqui.','go-home','Explorar músicas','heart'));
 else if(view==='queue'){root.innerHTML=heading('SEU PRÓXIMO PLAY','Fila de reprodução','Organize as próximas músicas sem sair do player.')+`<div class="page-tools"><button class="button button-primary" data-action="add-link">${icon('plus')}Adicionar música</button><button class="button button-quiet" data-action="clear-queue">Limpar fila</button><button class="button button-quiet" data-action="shuffle" aria-pressed="true">${icon('shuffle')}Aleatória</button><button class="button button-quiet" data-action="autoplay" aria-pressed="true">${icon('radio')}Continuar com semelhantes</button><button class="button button-quiet" data-action="new-session">Recomeçar sessão</button><button class="button button-quiet" data-action="sleep-settings">${icon('sun')}Temporizador</button></div><p id="queue-mode" class="search-result-note" role="status"></p><div id="queue-page-list" class="queue-list"></div>`;renderQueue();}
 else if(view==='library')root.innerHTML=heading('FEITA POR VOCÊ','Sua biblioteca','Cada playlist, um pedaço do seu mundo.')+`<div class="page-tools"><button class="button button-primary" data-action="create-playlist">${icon('plus')}Criar playlist</button><button class="button button-quiet" data-action="export">${icon('download')}Exportar</button><button class="button button-quiet" data-action="import">Importar</button></div>`+(library.playlists.length?`<input id="playlist-filter" class="form-input playlist-filter" type="search" value="${escape(playlistFilter)}" placeholder="Buscar playlist" aria-label="Buscar playlist"><div class="library-grid">${library.playlists.filter(list=>list.name.toLocaleLowerCase('pt-BR').includes(playlistFilter.toLocaleLowerCase('pt-BR'))).map(list=>`<button class="library-card" data-action="open-playlist" data-id="${escape(list.id)}"><span class="mini-cover">${icon('list')}</span><strong>${escape(list.name)}</strong><span>${list.tracks.length} músicas · playlist pessoal</span></button>`).join('')}</div>`:empty('Uma playlist para cada história','Para trabalhar, viajar ou só deixar o dia acontecer. Crie a primeira.','create-playlist','Criar minha primeira playlist'));
 else if(view==='playlist'){
  const list=library.playlists.find(item=>item.id===selectedPlaylist);
  if(!list){view='library';renderPage();return;}
  root.innerHTML=heading('SUA PLAYLIST',list.name,`${list.tracks.length} músicas · arraste ou use as setas para organizar`)+`<div class="page-tools"><button class="button button-primary" data-action="play-playlist" ${list.tracks.length?'':'disabled'}>${icon('play')}Ouvir playlist</button><button class="button button-secondary" data-action="add-link">${icon('plus')}Adicionar</button><button class="button button-quiet" data-action="rename-playlist">Renomear</button><button class="button button-quiet" data-action="share-playlist">Compartilhar</button><button class="button button-quiet" data-action="delete-playlist">Excluir</button></div>`+(list.tracks.length?libraryTools()+trackRows(sortAndFilter(list.tracks),{reorder:librarySort==='manual'&&!libraryFilter,remove:true,listId:list.id,select:true}):empty('O primeiro play é por sua conta','Adicione músicas pela busca ou cole um link do YouTube.'));
 } else if(view==='search')renderSearch();
 else if(view==='artist')renderArtist();
 else if(view==='shared'&&remotePlaylist)root.innerHTML=heading('UM SOM COMPARTILHADO COM VOCÊ',remotePlaylist.name,`${remotePlaylist.tracks.length} músicas · biblioteca do 4uMusic`)+`<div class="page-tools"><button class="button button-primary" data-action="play-shared" ${remotePlaylist.tracks.length?'':'disabled'}>${icon('play')}Ouvir</button><button class="button button-secondary" data-action="save-shared">${icon('plus')}Salvar na biblioteca</button></div>${trackRows(remotePlaylist.tracks)}${remotePlaylistPage?`<button class="button button-secondary load-more" data-action="more-playlist" ${remotePlaylistLoading?'disabled':''}>Carregar mais músicas</button>`:''}`;
}
function navigate(next,id){if(view!==next){selectedTracks.clear();libraryFilter='';librarySort='manual';}view=next;selectedPlaylist=id||null;$('#sidebar').classList.remove('open');$('.mobile-menu').setAttribute('aria-expanded','false');renderPage();$('#main').scrollTo({top:0});}
function renderSearch({loading=false,error='',more=false}={}){
 const tab=kind=>searchKind===kind?'active':'';
 let html=heading('ENCONTRE O QUE VOCÊ QUER OUVIR',searchQuery?`Resultados para “${searchQuery}”`:'Qual é o seu som de hoje?','Busque no YouTube ou cole um link para ouvir aqui.')+`<div class="search-tabs"><button class="chip ${tab('video')}" data-action="search-kind" data-kind="video">Músicas e vídeos</button><button class="chip ${tab('playlist')}" data-action="search-kind" data-kind="playlist">Playlists e álbuns</button><button class="chip ${tab('channel')}" data-action="search-kind" data-kind="channel">Artistas e canais</button></div><label class="search-filter"><input type="checkbox" id="search-official" ${searchFilter==='official'?'checked':''}>Priorizar vídeos oficiais e ocultar covers e versões ao vivo</label>`;
 const local=uniqueTracks([...library.favorites,...library.playlists.flatMap(list=>list.tracks)]).filter(track=>`${track.title} ${track.artist}`.toLocaleLowerCase('pt-BR').includes(searchQuery.toLocaleLowerCase('pt-BR'))).slice(0,8);
 if(local.length)html+=`<section class="local-results"><h2>Na sua biblioteca</h2>${trackRows(local)}</section>`;
 if(!searchQuery&&recentSearches.length)html+=`<div class="recent-searches"><strong>Buscas recentes</strong>${recentSearches.map(query=>`<button class="chip" data-action="recent-search" data-query="${escape(query)}">${escape(query)}</button>`).join('')}<button class="text-button" data-action="clear-searches">Limpar</button></div>`;
 if(loading)html+=Array.from({length:5},()=>'<div class="skeleton" aria-hidden="true"></div>').join('')+'<p role="status" class="search-result-note">Buscando no YouTube…</p>';
 else if(error)html+=`<div class="error-card" role="status"><h3>${config.searchEnabled?'Busca indisponível no momento':'Busca ainda não configurada'}</h3><p>${escape(error)}</p><div class="page-tools"><button class="button button-primary" data-action="retry-search">Tentar novamente</button><button class="button button-secondary" data-action="add-link">${icon('link')}Colar link</button><button class="button button-secondary" data-action="youtube-search">Buscar no YouTube ↗</button>${config.searchEnabled?'':'<button class="button button-quiet" data-action="setup">Como ativar</button>'}</div></div>`;
 else if(searchResults.length){
  html+='<p class="search-result-note">Resultados fornecidos pelo YouTube. Playlists e canais não equivalem a um catálogo completo do YouTube Music.</p>';
  if(searchKind==='video'){const filtered=searchResults.filter(track=>searchFilter==='all'||isPreferredMusicVideo(track));html+=filtered.length?trackRows(filtered):'<p class="search-result-note">Nenhum vídeo corresponde a este filtro. Desmarque a opção para ver todos os resultados.</p>';}
  else html+=`<div class="track-list">${searchResults.map(item=>`<article class="track-row"><img class="track-image" src="${escape(item.thumbnail||'assets/icon.svg')}" alt="Imagem de ${escape(item.title)}" loading="lazy"><button class="track-title-button" data-action="${searchKind==='playlist'?'open-youtube-playlist':'open-artist'}" data-id="${escape(item.id)}"><strong>${escape(item.title)}</strong><span>${escape(item.artist)} · ${searchKind==='playlist'?'playlist do YouTube':'canal do YouTube'}</span></button><button class="icon-button" data-action="${searchKind==='playlist'?'open-youtube-playlist':'open-artist'}" data-id="${escape(item.id)}" aria-label="Abrir ${escape(item.title)}">${icon('arrow')}</button></article>`).join('')}</div>`;
  if(nextPage)html+='<button class="button button-secondary load-more" data-action="more-search">Carregar mais resultados</button>';
 } else html+=local.length?'<p class="search-result-note">Pressione Enter para buscar também no YouTube.</p>':empty(searchQuery?'Nenhum resultado por aqui':'Encontre uma música pelo nome','Experimente o nome da música, o artista ou um link do YouTube.','focus-search','Buscar música','search');
 $('#page-content').innerHTML=html;
}
async function search(query,{append=false,kind=searchKind}={}){
 query=cleanText(query,200);if(!query){navigate('search');$('#search-input').focus();return;}
 const id=videoIdFrom(query);if(id){openLinkDialog(query);return;}
 searchController?.abort();searchController=new AbortController();const seq=++searchSeq;
 searchQuery=query;searchKind=kind;view='search';$('#search-input').value=query;renderSidebar();renderSearch({loading:true});if(!append)$('#main').scrollTo({top:0});
 try{const data=await api('search',{query:{q:query,kind,page:append?nextPage:''},signal:searchController.signal});if(seq!==searchSeq||view!=='search')return;const items=append?[...searchResults,...data.items]:data.items;searchResults=kind==='video'?rankMusicResults(items,query):kind==='channel'?[...items].sort((a,b)=>Number(b.title.toLocaleLowerCase('pt-BR')===query.toLocaleLowerCase('pt-BR'))-Number(a.title.toLocaleLowerCase('pt-BR')===query.toLocaleLowerCase('pt-BR'))):items;nextPage=data.nextPage||'';if(!append)rememberSearch(query);renderSearch();}
 catch(error){if(error.name==='AbortError'||seq!==searchSeq||view!=='search')return;searchResults=[];nextPage='';const message=!navigator.onLine?'Sem conexão. Confira a internet e tente novamente.':error.code==='youtube_quota'||error.status===429?'O limite de buscas foi atingido. Tente mais tarde ou abra uma música salva.':error instanceof TypeError?'Não foi possível conectar ao serviço. Tente novamente.':error.message;renderSearch({error:message});}
}
function renderArtist(){
 if(!selectedArtist)return;
 const root=$('#page-content');
 root.innerHTML=heading('ARTISTA · CANAL DO YOUTUBE',selectedArtist.title,'Vídeos publicados neste canal; a organização em músicas e álbuns é aproximada.')+
 `<div class="page-tools"><button class="button button-primary" data-action="play-artist" ${artistTracks.length?'':'disabled'}>${icon('play')}Ouvir músicas</button><button class="button button-secondary" data-action="artist-albums">Procurar álbuns e playlists</button></div>`+
 (artistLoading?'<div class="skeleton"></div><p class="search-result-note">Carregando vídeos do canal…</p>':'')+
 (artistTracks.length?`<section><div class="section-heading"><h2>Vídeos musicais</h2></div>${trackRows(artistTracks)}</section>`:artistLoading?'':'<p class="search-result-note">Ainda não encontramos vídeos incorporáveis deste canal. Você pode tentar outra busca.</p>')+
 (artistPage?'<button class="button button-secondary load-more" data-action="artist-more">Carregar mais vídeos</button>':'')+
 (artistAlbums.length?`<section><div class="section-heading"><h2>Playlists deste canal</h2></div><p class="search-result-note">Publicadas pelo canal no YouTube; confirme o conteúdo antes de salvar como álbum.</p><div class="album-grid">${artistAlbums.map(item=>`<button class="album-card" data-action="open-youtube-playlist" data-id="${escape(item.id)}"><img src="${escape(item.thumbnail||'assets/icon.svg')}" alt="" loading="lazy"><strong>${escape(item.title)}</strong><span>${escape(item.artist)}</span></button>`).join('')}</div></section>`:'');
}
async function openArtist(id){
 const item=searchResults.find(result=>result.id===id);if(!item)return;
 selectedArtist={id,title:item.title,thumbnail:item.thumbnail};artistTracks=[];artistAlbums=[];artistPage='';view='artist';renderSidebar();renderArtist();$('#main').scrollTo({top:0});await loadArtistTracks();
}
async function loadArtistTracks(){
 if(!selectedArtist||artistLoading)return;
 const id=selectedArtist.id,page=artistPage;artistLoading=true;renderArtist();
 try{const data=await api('search',{query:{kind:'video',channel:id,page}});if(selectedArtist?.id!==id)return;artistTracks=rankMusicResults(uniqueTracks([...artistTracks,...data.items]),selectedArtist.title);artistPage=data.nextPage||'';}
 catch(error){toast(error.message);}finally{artistLoading=false;if(view==='artist'&&selectedArtist?.id===id)renderArtist();}
}
async function loadArtistAlbums(){if(!selectedArtist)return;const name=selectedArtist.title;try{const data=await api('search',{query:{q:`${name} album official`,kind:'playlist'}});if(selectedArtist?.title!==name)return;artistAlbums=(data.items||[]).filter(item=>item.artist.toLocaleLowerCase('pt-BR')===name.toLocaleLowerCase('pt-BR'));renderArtist();if(!artistAlbums.length)toast('Nenhuma playlist publicada por este canal foi encontrada.');}catch(error){toast(error.message);}}
function modal(title,body){$('#modal-title').textContent=title;$('#modal-body').innerHTML=body;if(!$('#modal').open)$('#modal').showModal();setTimeout(()=>$('#modal-body input')?.focus(),40);}
function closeModal(){$('#modal').close();}
function isAppInstalled(){return installedThisSession||standaloneMode.matches||navigator.standalone===true;}
function updateInstallButton(){
 const button=$('#sidebar-install');
 button.disabled=installationPending||isAppInstalled();
 $('#install-label').textContent=isAppInstalled()?'Instalado':installationPending?'Aguardando…':'Instalar';
 button.title=isAppInstalled()?'4uMusic já instalado ou aberto como aplicativo':'Instalar o 4uMusic neste dispositivo';
}
function showInstallGuide(){
 modal('Instalar o 4uMusic',`<div class="install-preview"><img src="assets/pwa-icon-192.png" alt="Ícone do 4uMusic" width="72" height="72"><div><strong>4uMusic</strong><span>Seu som, na sua tela inicial.</span></div></div><ol class="install-steps"><li><strong>Android (Chrome ou Edge):</strong> abra o menu ⋮ do navegador e escolha “Instalar aplicativo” ou “Adicionar à tela inicial”.</li><li><strong>iPhone ou iPad (Safari):</strong> toque em Compartilhar e depois em “Adicionar à Tela de Início”.</li><li><strong>Computador:</strong> procure o ícone de instalação na barra de endereços ou a opção “Instalar” no menu do navegador.</li></ol><p>Se a opção não aparecer, abra este endereço em um navegador compatível e confira se o app já está instalado.</p><p class="inline-note">Sua biblioteca local pode ser aberta offline após a primeira visita. Busca, capas, login e reprodução precisam de internet.</p><div class="modal-actions"><a class="button button-secondary" href="tutorial.html#instalar">Ajuda para instalar</a><button class="button button-primary" data-action="close-modal">Entendi</button></div>`);
}
async function installApp(){
 $('#sidebar').classList.remove('open');$('.mobile-menu').setAttribute('aria-expanded','false');
 if(isAppInstalled()){toast('O 4uMusic já está instalado ou aberto como aplicativo.');return;}
 if(installationPending)return;
 const prompt=installPrompt;
 if(!prompt){showInstallGuide();return;}
 // Each browser install event can be used only once, even if dismissed.
 installPrompt=null;installationPending=true;updateInstallButton();closeModal();
 try{
  const result=await prompt.prompt();
  const choice=result?.outcome?result:await prompt.userChoice;
  if(choice?.outcome==='accepted'&&!installedThisSession)toast('Instalação confirmada. Aguarde a conclusão pelo navegador.');
 }catch{showInstallGuide();}
 finally{installationPending=false;updateInstallButton();}
}
function openLinkDialog(value=''){
 modal('Dê play em um link.',`<p>Copie o link de um vídeo do YouTube. Sua música fica aqui, com o vídeo e o player oficial visíveis.</p><form id="link-form"><label class="form-label" for="link-input">Link do YouTube</label><input class="form-input" id="link-input" type="text" inputmode="url" maxlength="500" required value="${escape(value)}" placeholder="https://www.youtube.com/watch?v=…"><label class="form-label" for="link-title">Nome para identificar na sua biblioteca (opcional)</label><input class="form-input" id="link-title" type="text" maxlength="240" placeholder="Nome da música"><p class="form-error" id="link-error" role="alert"></p><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancelar</button><button type="submit" class="button button-primary">${icon('play')}Adicionar e ouvir</button></div></form>`);
}
async function addLink(event){
 event.preventDefault();const id=videoIdFrom($('#link-input').value);if(!id){$('#link-error').textContent='Cole um link válido de vídeo do YouTube, YouTube Music ou youtu.be.';return;}
 const title=cleanText($('#link-title').value,240),submit=event.target.querySelector('[type=submit]');submit.disabled=true;submit.textContent='Adicionando…';
 let track=normalizeTrack({id,title:title||'Vídeo do YouTube',artist:'YouTube'});
 try{const data=await api('resolve',{query:{id}});track=normalizeTrack({...data.track,title:title||data.track.title});}catch{toast('Link adicionado. O título pode ser ajustado nas opções da faixa.');}
 if(view==='playlist'){const list=library.playlists.find(item=>item.id===selectedPlaylist);if(list&&!list.tracks.some(item=>item.id===id)){list.tracks.push(track);saveLibrary();renderPage();}}
 closeModal();playTrack(track);
}
function playlistDialog({rename=false,addTrack=null}={}){
 const list=rename?library.playlists.find(item=>item.id===selectedPlaylist):null;
 modal(rename?'Um novo nome.':'Crie sua próxima playlist.',`<p>${rename?'Dê um nome que combine com esse momento.':'Uma viagem, um sentimento ou só suas músicas favoritas.'}</p><form id="playlist-form" data-rename="${rename?'1':''}" data-track="${addTrack?.id||''}"><label class="form-label" for="playlist-name">Nome da playlist</label><input class="form-input" id="playlist-name" maxlength="80" required value="${escape(list?.name||'')}" placeholder="Ex.: Estrada, café e música"><p id="playlist-error" class="form-error" role="alert"></p><div class="modal-actions"><button type="button" class="button button-secondary" data-action="close-modal">Cancelar</button><button class="button button-primary" type="submit">${rename?'Salvar nome':'Criar playlist'}</button></div></form>`);
}
function createPlaylist(event){event.preventDefault();const name=cleanText($('#playlist-name').value,80);if(!name){$('#playlist-error').textContent='Escolha um nome para a playlist.';return;}let id=selectedPlaylist;
 if(event.target.dataset.rename){const list=library.playlists.find(item=>item.id===selectedPlaylist);if(list)list.name=name;}
 else{if(library.playlists.length>=100){$('#playlist-error').textContent='Limite de 100 playlists. Exporte ou remova uma antes de criar outra.';return;}id=uid();const track=getTrack(event.target.dataset.track);library.playlists.push({id,name,tracks:track?[track]:[]});}
 saveLibrary();closeModal();navigate('playlist',id);toast('Playlist salva');
}
function choosePlaylist(track){selectionTrack=track;modal('Vai para qual playlist?',`<p>${escape(track.title)}</p><div class="playlist-options">${library.playlists.map(list=>`<button class="playlist-option" data-action="add-to-playlist" data-id="${escape(list.id)}"><span class="mini-cover">${icon('list')}</span><span>${escape(list.name)}</span><small>${list.tracks.length} músicas</small></button>`).join('')}</div><div class="modal-actions"><button class="button button-primary" data-action="create-for-track">${icon('plus')}Nova playlist</button></div>`);}
function trackOptions(track){selectionTrack=track;modal(track.title,`<p>${escape(track.artist)} · YouTube</p><div class="playlist-options"><button class="playlist-option" data-action="play-selected">${icon('play')}Ouvir agora</button><button class="playlist-option" data-action="next-selected">${icon('list')}Tocar a seguir</button><button class="playlist-option" data-action="enqueue-selected">${icon('list')}Adicionar à fila</button><button class="playlist-option" data-action="playlist-selected">${icon('plus')}Adicionar a uma playlist</button><button class="playlist-option" data-action="favorite-selected">${icon('heart')}${isFavorite(track.id)?'Remover das favoritas':'Salvar nas favoritas'}</button><button class="playlist-option" data-action="versions-selected">${icon('search')}Buscar outras versões</button><button class="playlist-option" data-action="rename-selected">Editar nome na biblioteca</button><button class="playlist-option" data-action="dislike-selected">${taste.disliked.includes(track.id)?'Voltar a recomendar':'Não recomendar esta música'}</button><a class="playlist-option" href="${youtubeUrl(track.id)}" target="_blank" rel="noopener noreferrer">${icon('arrow')}Abrir no YouTube</a></div>`);}
function updateTrackName(event){event.preventDefault();const title=cleanText($('#track-name').value,240);if(!title)return;const id=selectionTrack.id;for(const list of [queue,library.favorites,...library.playlists.map(item=>item.tracks)])for(const track of list)if(track.id===id)track.title=title;selectionTrack.title=title;saveLibrary();renderPage();updateNow();renderQueue();closeModal();}
function showSetup(){modal('Ativar a busca completa',`<p>Você já pode ouvir por links, favoritar e criar playlists. Para pesquisar diretamente no aplicativo, o administrador precisa configurar a YouTube Data API v3.</p><div class="steps"><div class="step">Criar ou selecionar um projeto no Google Cloud.</div><div class="step">Ativar a YouTube Data API v3 e gerar uma chave restrita.</div><div class="step">Configurar a chave no servidor e recarregar o 4uMusic.</div></div><div class="inline-note">A chave fica no servidor. A busca respeita a cota do Google. Não é necessário fornecer sua senha ou cookies do YouTube.</div><div class="setup-links"><a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener noreferrer">Abrir Google Cloud ↗</a><a href="tutorial.html#administrador">Guia de configuração ↗</a></div>`);}
function showHelp(){modal('Seu próximo play, sem complicar.',`<div class="steps"><div class="step">Busque uma música ou cole um link do YouTube.</div><div class="step">Toque no coração para salvar nas favoritas.</div><div class="step">Use o menu da faixa para criar sua playlist.</div></div><p>A biblioteca é salva neste navegador. Exporte uma cópia para levar suas playlists com você.</p><div class="modal-actions"><button class="button button-secondary" data-action="export">${icon('download')}Exportar biblioteca</button><a class="button button-primary" href="tutorial.html">Tutorial completo ↗</a></div><div class="settings-row"><span>Busca no YouTube</span><button class="text-button" data-action="setup">${config.searchEnabled?'Ativada':'Aguardando configuração'}</button></div><div class="settings-row"><span>Instalar aplicativo</span><button class="text-button" data-action="install">Como instalar</button></div><div class="settings-row"><a href="privacidade.html">Privacidade</a><a href="termos.html">Termos de uso</a></div><p>Um projeto de Fabiano Braga · <a href="https://github.com/4u-Labs" target="_blank" rel="noopener noreferrer">4u-Labs</a>. <a href="https://www.paypal.com/ncp/payment/L7YRCS984T33N" target="_blank" rel="noopener noreferrer">Apoie o projeto ↗</a></p>`);}
function exportLibrary(){const blob=new Blob([JSON.stringify(library,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`4umusic-biblioteca-${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Sua biblioteca foi exportada');}
async function importLibrary(file){if(!file)return;if(file.size>2_000_000){toast('O arquivo deve ter até 2 MB.');return;}try{const incoming=normalizeLibrary(JSON.parse(await file.text()));modal('Importar sua biblioteca?',`<p>Encontramos ${incoming.favorites.length} favoritas e ${incoming.playlists.length} playlists. Elas serão adicionadas à sua biblioteca, sem apagar o que você já tem.</p><div class="modal-actions"><button class="button button-secondary" data-action="close-modal">Cancelar</button><button id="confirm-import" class="button button-primary">Importar</button></div>`);$('#confirm-import').onclick=()=>{library=mergeLibraries(library,incoming);saveLibrary();closeModal();navigate('library');toast('Biblioteca importada');};}catch(error){toast(error.message||'Não foi possível importar este arquivo.');}}
async function sharePlaylist(){const list=library.playlists.find(item=>item.id===selectedPlaylist);if(!list)return;const serialized=JSON.stringify({schema:1,favorites:[],playlists:[list]});const bytes=new TextEncoder().encode(serialized);let binary='';for(const b of bytes)binary+=String.fromCharCode(b);const encoded=btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');if(encoded.length>12000){toast('Esta playlist é grande demais para um link. Use a exportação da biblioteca.');return;}const url=new URL('./',location.href);url.hash=`playlist=${encoded}`;try{await navigator.clipboard.writeText(url.href);toast('Link copiado. Quem receber poderá ver toda a playlist.');}catch{modal('Compartilhar playlist',`<p>Quem abrir este link poderá ver os títulos e ouvir os vídeos disponíveis.</p><label class="form-label" for="share-url">Copie o link</label><input class="form-input" id="share-url" readonly value="${escape(url.href)}">`);$('#share-url').select();}}
function readShared(){if(!location.hash.startsWith('#playlist='))return;try{const value=location.hash.slice(10);if(value.length>12000)throw new Error();const encoded=value.replace(/-/g,'+').replace(/_/g,'/');const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));const data=normalizeLibrary(JSON.parse(new TextDecoder().decode(bytes)));remotePlaylist=data.playlists[0];if(!remotePlaylist)throw new Error();view='shared';}catch{history.replaceState(null,'',location.pathname+location.search);toast('O link da playlist não é válido.');}}
function ensurePlayer(){
 if(playerReady)return Promise.resolve();
 if(!playerLoading){playerLoading=true;$('#player-message').textContent='Conectando ao player do YouTube…';window.onYouTubeIframeAPIReady=createPlayer;const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';script.onerror=()=>{playerLoading=false;$('#player-message').textContent='Não foi possível carregar o YouTube. Confira sua conexão e tente novamente.';};document.head.append(script);if(window.YT?.Player)createPlayer();}
 return new Promise((resolve,reject)=>{let attempts=0;const poll=setInterval(()=>{if(playerReady){clearInterval(poll);resolve();}else if(++attempts>80){clearInterval(poll);reject(new Error('O YouTube demorou para responder. Tente novamente.'));}},250);});
}
function createPlayer(){if(player)return;player=new window.YT.Player('youtube-player',{width:'100%',height:200,videoId:currentTrack()?.id,playerVars:{playsinline:1,controls:1,origin:location.origin,rel:0,enablejsapi:1},events:{onReady:()=>{playerReady=true;playerLoading=false;$('#video-placeholder').hidden=true;$('#video-placeholder').style.display='none';player.setVolume(Number($('#volume').value));$('#player-message').textContent='';},onStateChange:onPlayerState,onError:onPlayerError,onAutoplayBlocked:()=>{desiredPlayback=false;transportEpoch++;$('#player-message').textContent='Toque em reproduzir no vídeo para começar. Seu navegador bloqueou o início automático.';setPlaying(false);}}});}
let playbackRequest=0;
function saveMusicSession(){try{sessionStorage.setItem('4umusic:session:v1',JSON.stringify(musicSession.snapshot()));}catch{}}
function beginQueueContext(seed,context=''){
 queueEpoch++;transportEpoch++;radioController?.abort();radioTask=null;nextOperation=null;radioAdded.clear();radioSeed=seed;radioContext=context;radioError='';consecutiveFailures=0;
}
function currentCollection(){
 if(view==='favorites')return library.favorites;
 if(view==='playlist')return library.playlists.find(item=>item.id===selectedPlaylist)?.tracks||[];
 if(view==='shared')return remotePlaylist?.tracks||[];
 if(view==='artist')return artistTracks;
 return [];
}
function updatePlaybackControls(){
 document.querySelectorAll('[data-action="shuffle"]').forEach(button=>{button.classList.toggle('active',shuffle);button.setAttribute('aria-pressed',String(shuffle));});
 document.querySelectorAll('[data-action="autoplay"]').forEach(button=>{button.classList.toggle('active',autoRadio);button.setAttribute('aria-pressed',String(autoRadio));});
 const status=$('#queue-mode');if(status)status.textContent=`${shuffle?'Aleatória':'Em ordem'} · sem repetir nesta sessão · ${musicSession.count()} faixas já iniciadas${autoRadio?' · semelhantes ao fim da coleção':''}`;
}
async function fillRadio(){
 if(!autoRadio||!config.searchEnabled||!radioSeed)return 0;
 const epoch=queueEpoch;if(radioTask?.epoch===epoch)return radioTask.promise;
 const task={epoch,promise:null};radioTask=task;
 task.promise=(async()=>{
  radioController=new AbortController();const signal=radioController.signal;
  const seeds=uniqueTracks([...library.favorites,...recentTracks]).filter(track=>!taste.disliked.includes(track.id)&&!taste.skipped.includes(track.id));
  const seed=mixMode==='similar'?currentTrack()||radioSeed:seeds.length&&radioPages.size%3!==0?seeds[radioPages.size%seeds.length]:currentTrack()||radioSeed;
  const query=mixMode==='similar'?recommendationQuery(seed,radioContext):mixMode==='discovery'?similarStyleQuery(seed,radioContext):radioPages.size%3===0?similarStyleQuery(seed,radioContext):recommendationQuery(seed,radioContext);
  let cursor=radioPages.get(query)||{started:false,page:'',exhausted:false};
  try{
   for(let attempt=0;attempt<2&&!cursor.exhausted;attempt++){
    const data=await api('search',{query:{q:query,kind:'video',page:cursor.started?cursor.page:'',purpose:'radio'},signal});
    if(epoch!==queueEpoch||!autoRadio)return 0;
    cursor={started:true,page:data.nextPage||'',exhausted:!data.nextPage};radioPages.set(query,cursor);
    const queuedIds=new Set(queue.map(track=>track.id));
    const queuedSongs=createMusicSession();queue.forEach(track=>queuedSongs.mark(track));
    const fresh=musicSession.unheard(data.items||[]).filter(track=>!queuedIds.has(track.id)&&!queuedSongs.has(track)&&!taste.disliked.includes(track.id)&&!taste.skipped.includes(track.id));
    const preferred=fresh.filter(track=>!/\b(live|ao vivo|cover|karaoke|reaction|aula|tradu[çc]|lyrics?|legendad)\b/i.test(track.title));
    const chosen=preferred.length>=3?preferred:fresh;
    const ranked=rankMusicResults(chosen,query);
    if(ranked.length){ranked.forEach(track=>radioAdded.add(track.id));queue.push(...(shuffle?spreadArtists(shuffled(ranked)):ranked));radioError='';renderQueue();return ranked.length;}
   }
   radioError='Não encontramos novas faixas semelhantes sem repetir as que já passaram pela sessão.';
  }catch(error){if(error.name!=='AbortError'&&epoch===queueEpoch)radioError=error.message;}
  finally{if(radioTask===task)radioTask=null;}
  return 0;
 })();
 return task.promise;
}
function prefetchRadio(){if(autoRadio&&config.searchEnabled&&musicSession.unheard(queue).length<=2)void fillRadio();}
async function playTrack(track,{index=null}={}){
 if(!track)return;track=normalizeTrack(track);if(!track)return;
 if(index===null){
  resumeStart=0;
  const collection=currentCollection();
 const context=view==='playlist'?library.playlists.find(item=>item.id===selectedPlaylist)?.name||'':view==='artist'?selectedArtist?.title||'':view==='search'?searchQuery:'';
  beginQueueContext(track,context);
  const remaining=musicSession.unheard(collection).filter(item=>item.id!==track.id);
  queue=[track,...(shuffle?spreadArtists(shuffled(remaining)):remaining)];currentIndex=0;
 }else currentIndex=index;
 desiredPlayback=true;musicSession.mark(track);saveMusicSession();resumeSeconds=0;saveQueue();
 const request=++playbackRequest;seekInteracting=false;$('#seek').value=0;updateNow();renderQueue();renderActiveTracks();
 try{await ensurePlayer();if(request!==playbackRequest)return;player.loadVideoById({videoId:track.id,startSeconds:resumeStart||0});resumeStart=0;$('#player-message').textContent='Se a reprodução não começar, toque em play no vídeo.';}
 catch(error){desiredPlayback=false;$('#player-message').textContent=error.message;toast(error.message);}
}
function playCollection(tracks){
 if(!tracks.length)return;
 const fresh=musicSession.unheard(tracks),context=view==='playlist'?library.playlists.find(item=>item.id===selectedPlaylist)?.name||'':'';
 beginQueueContext(tracks[0],context);
 queue=shuffle?spreadArtists(shuffled(fresh)):fresh;currentIndex=-1;
 if(queue.length){currentIndex=0;return playTrack(queue[0],{index:0});}
 else{toast('Todas as faixas dessa coleção já passaram pela sessão. Buscando semelhantes…');return nextTrack();}
}
function setPlaying(value){playing=value;void screenWakeLock.setPlaying(value);updateTransportButton();}
function updateTransportButton(){const pending=!!nextOperation&&desiredPlayback;$('#play-button').innerHTML=icon(playing||pending?'pause':'play');$('#play-button').setAttribute('aria-label',playing?'Pausar':pending?'Cancelar próxima música':'Reproduzir');}
function scheduleVideoVisibilityCheck(){
 layoutSettlingUntil=performance.now()+650;clearTimeout(visibilityTimer);
 visibilityTimer=setTimeout(()=>{pauseHiddenVideo();if(playing)void screenWakeLock.setVisible(!document.hidden);},700);
}
async function lockPortrait(){
 if(!(standaloneMode.matches||navigator.standalone===true)||!screen.orientation?.lock)return;
 try{await screen.orientation.lock('portrait-primary');}catch{/* Orientation lock is optional on this browser. */}
}
function videoVisible(){
 const r=$('#youtube-player').getBoundingClientRect(),viewport=window.visualViewport;
 const top=viewport?.offsetTop||0,left=viewport?.offsetLeft||0;
 const bottom=Math.min(top+(viewport?.height||innerHeight),$('.player-bar').getBoundingClientRect().top);
 return !document.hidden&&r.width>=199&&r.height>=199&&r.top>=top-1&&r.bottom<=bottom+1&&r.left>=left-1&&r.right<=left+(viewport?.width||innerWidth)+1;
}
function pauseHiddenVideo(){if(!document.hidden&&performance.now()<layoutSettlingUntil)return;if(playerReady&&playing&&!videoVisible()){desiredPlayback=false;transportEpoch++;player.pauseVideo();$('#player-message').textContent='Reprodução pausada. Mantenha o vídeo visível para continuar.';}}
function stopForSleep(){clearTimeout(sleepTimer);sleepTimer=null;sleepAtEnd=false;sleepUntil=0;desiredPlayback=false;transportEpoch++;if(playerReady)player.pauseVideo();setPlaying(false);toast('Temporizador concluído. Reprodução pausada.');}
function sleepSettings(){const remaining=sleepUntil?Math.max(1,Math.ceil((sleepUntil-Date.now())/60000)):0;modal('Temporizador',`<p>${sleepAtEnd?'O app vai parar ao fim desta música.':remaining?`Faltam cerca de ${remaining} minutos.`:'Escolha quando parar a reprodução.'}</p><div class="playlist-options"><button class="playlist-option" data-action="sleep-minutes" data-minutes="15">Parar em 15 minutos</button><button class="playlist-option" data-action="sleep-minutes" data-minutes="30">Parar em 30 minutos</button><button class="playlist-option" data-action="sleep-minutes" data-minutes="60">Parar em 60 minutos</button><button class="playlist-option" data-action="sleep-end">Parar ao terminar esta música</button><button class="playlist-option" data-action="sleep-cancel">Desativar temporizador</button></div>`);}
function onPlayerState(event){
 setPlaying(event.data===1);
 if(event.data===1){desiredPlayback=true;consecutiveFailures=0;$('#player-message').textContent='';if(currentTrack())rememberTrack(currentTrack());pauseHiddenVideo();if(playing&&desiredPlayback)prefetchRadio();}
 if(event.data===2){desiredPlayback=false;transportEpoch++;}
 if(event.data===0&&sleepAtEnd){stopForSleep();return;}
 if(event.data===0&&desiredPlayback)void nextTrack({automatic:true});
}
function onPlayerError(event){
 setPlaying(false);
 const messages={2:'O link deste vídeo não é válido.',5:'Seu navegador não conseguiu reproduzir este vídeo.',100:'Este vídeo foi removido ou está privado.',101:'Este vídeo só pode ser reproduzido no YouTube.',150:'Este vídeo só pode ser reproduzido no YouTube.',153:'O YouTube não recebeu a identificação deste site. Abra o app pelo endereço HTTPS configurado.'};
 $('#player-message').textContent=messages[event.data]||'Este vídeo não pôde ser reproduzido.';
 const epoch=queueEpoch;
 if(desiredPlayback&&[100,101,150].includes(event.data)&&++consecutiveFailures<3){$('#player-message').textContent+=' Tentando a próxima faixa…';setTimeout(()=>{if(epoch===queueEpoch&&desiredPlayback&&!document.hidden)void nextTrack({automatic:true});},900);}
 else{desiredPlayback=false;transportEpoch++;$('#player-message').textContent+=' Escolha outra versão ou avance na fila.';}
}
async function nextTrack({automatic=false}={}){
 if(nextOperation)return nextOperation;
 if(automatic&&(!desiredPlayback||document.hidden))return;
 desiredPlayback=true;const epoch=queueEpoch,token=++transportEpoch;
 const operation=(async()=>{
  let next=nextQueueIndex();
  if(next<0&&autoRadio){$('#player-message').textContent='Buscando próximas músicas semelhantes…';await fillRadio();next=nextQueueIndex();}
  if(epoch!==queueEpoch||token!==transportEpoch||!desiredPlayback||document.hidden)return;
  if(next>=0){await playTrack(queue[next],{index:next});return;}
  desiredPlayback=false;setPlaying(false);
  $('#player-message').textContent=radioError||'Você ouviu todas as faixas disponíveis nesta sessão. Adicione novas músicas ou recomece a sessão na fila.';
 })();
 nextOperation=operation;updateTransportButton();
 try{await operation;}finally{if(nextOperation===operation)nextOperation=null;updateTransportButton();}
}
function previousTrack(){if(playerReady&&player.getCurrentTime()>3){player.seekTo(0,true);return;}if(currentIndex>0)playTrack(queue[currentIndex-1],{index:currentIndex-1});}
function updateNow(){const track=currentTrack();$('#now-title').textContent=track?.title||'O que vamos ouvir?';$('#now-artist').textContent=track?.artist||'A trilha sonora é sua.';$('#bar-title').textContent=track?.title||'Encontre seu próximo som';$('#bar-artist').textContent=track?.artist||'4uMusic · Seu som, seu espaço';$('#bar-art').innerHTML=track?`<img src="${thumbUrl(track.id)}" alt="">`:icon('list');$('#youtube-source').href=track?youtubeUrl(track.id):'https://www.youtube.com/';$('#seek').disabled=!track;updateFavorites();}
function nextQueueIndex(){for(let offset=1;offset<=queue.length;offset++){const index=(currentIndex+offset+queue.length)%queue.length;if(!musicSession.has(queue[index]))return index;}return -1;}
function renderQueue(){saveQueue();updatePlaybackControls();$('#queue-count').textContent=queue.length;const next=queue[nextQueueIndex()];const html=queue.length?queue.map((track,index)=>`<div class="queue-item ${index===currentIndex?'active':''}"><img class="q-image" src="${thumbUrl(track.id)}" alt="" loading="lazy"><button class="q-title" data-action="queue-play" data-index="${index}"><strong>${escape(track.title)}</strong><span>${escape(track.artist)}</span></button><button class="icon-button" data-action="queue-up" data-index="${index}" aria-label="Mover faixa para cima" ${index===0?'disabled':''}>${icon('up')}</button><button class="icon-button" data-action="queue-remove" data-index="${index}" aria-label="Remover ${escape(track.title)} da fila" ${index===currentIndex?'disabled':''}>${icon('close')}</button></div>`).join(''):'<div class="queue-empty">Sua fila está esperando um som.<br>Adicione uma música para começar.</div>';for(const target of document.querySelectorAll('#queue-list,#queue-page-list'))target.innerHTML=html;const label=$('#next-track-label');if(label)label.textContent=next?`A seguir: ${next.title}`:'A seguir: sugestões quando esta coleção terminar';}
function renderActiveTracks(){document.querySelectorAll('.track-row').forEach(el=>el.classList.toggle('active',el.querySelector('[data-action="play-track"]')?.dataset.id===currentTrack()?.id));}
function enqueue(track,{next=false}={}){if(!track)return;if(musicSession.has(track)||queue.some(item=>item.id===track.id)){toast('Essa faixa já está na fila ou passou pela sessão.');return;}const item=normalizeTrack(track);if(next)queue.splice(currentIndex+1,0,item);else queue.push(item);renderQueue();toast(next?'Será a próxima música':'Adicionada à fila');}
function movePlaylist(id,from,to){const list=library.playlists.find(item=>item.id===id);if(!list)return;list.tracks=moveItem(list.tracks,from,to);saveLibrary();renderPage();}
async function openYouTubePlaylist(id){const item=[...searchResults,...artistAlbums].find(item=>item.id===id);modal('Carregando playlist…','<p>Consultando as faixas disponíveis no YouTube.</p>');try{const data=await api('playlist',{query:{id}});remotePlaylist={id:uid(),name:item?.title||'Playlist do YouTube',tracks:data.items};remotePlaylistSource=id;remotePlaylistPage=data.nextPage||'';closeModal();view='shared';renderPage();toast(remotePlaylistPage?'Primeiras músicas carregadas. Use “Carregar mais” para continuar.':'Playlist carregada');}catch(error){modal('Não foi possível abrir a playlist',`<p>${escape(error.message)}</p><a class="button button-secondary" href="https://www.youtube.com/playlist?list=${encodeURIComponent(id)}" target="_blank" rel="noopener noreferrer">Abrir no YouTube ↗</a>`);}}
async function moreYouTubePlaylist(){if(!remotePlaylistPage||remotePlaylistLoading||!remotePlaylistSource)return;remotePlaylistLoading=true;const source=remotePlaylistSource,page=remotePlaylistPage;renderPage();try{const data=await api('playlist',{query:{id:source,page}});if(source!==remotePlaylistSource)return;remotePlaylist.tracks=uniqueTracks([...remotePlaylist.tracks,...data.items]);remotePlaylistPage=data.nextPage||'';toast(remotePlaylistPage?`${remotePlaylist.tracks.length} músicas carregadas. Carregue mais para continuar.`:'Playlist completa carregada.');}catch(error){toast(error.message);}finally{remotePlaylistLoading=false;if(view==='shared')renderPage();}}
async function showAccount(){
 if(user){modal('Sua conta',`<p>${escape(user.name||user.email)}</p><div class="inline-note">${syncPaused?'A sincronização da biblioteca está pausada. Exporte suas playlists antes de sair.':'Favoritas, playlists, histórico, preferências e ponto de retomada são sincronizados com sua conta 4uMusic. O login no player do YouTube é independente.'}</div><div class="modal-actions"><button class="button button-secondary" data-action="export">Exportar biblioteca</button><button class="button button-secondary" data-action="logout">Sair</button></div><div class="settings-row"><span>Gerenciar dados da conta</span><button class="text-button" data-action="delete-account">Excluir meus dados</button></div>`);return;}
 if(config.authMode!=='google'){modal('Sua biblioteca, com você.',`<p>Você pode ouvir e organizar músicas agora. Nesta prévia, suas playlists ficam salvas no navegador.</p><div class="inline-note">O login Google e a sincronização estão implementados na versão PHP para o 4U.IA.BR. A ativação depende da configuração das origens autorizadas no Google Cloud. O login do 4uMusic não transfere a assinatura Premium para o player.</div><div class="modal-actions"><button class="button button-secondary" data-action="export">Exportar biblioteca</button><a class="button button-primary" href="tutorial.html#administrador">Ver configuração ↗</a></div>`);return;}
 modal('Seu espaço em qualquer tela.',`<p>Entre com Google para sincronizar favoritas, playlists, histórico e ponto de retomada. Sua senha não passa pelo 4uMusic.</p><div id="google-signin"></div><p id="google-error" class="form-error" role="alert"></p><div class="inline-note">O login do 4uMusic é independente do login no YouTube. Os anúncios e benefícios Premium são administrados pelo próprio YouTube.</div>`);
 try{if(!window.google?.accounts?.id){await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://accounts.google.com/gsi/client';script.onload=resolve;script.onerror=reject;document.head.append(script);});}if(!$('#google-signin'))return;window.google.accounts.id.initialize({client_id:config.googleClientId,nonce:config.nonce,callback:googleLogin,auto_select:false});window.google.accounts.id.renderButton($('#google-signin'),{theme:'outline',size:'large',text:'signin_with',width:Math.min(360,$('#modal-body').clientWidth)});}catch{$('#google-error').textContent='O login Google não carregou. Confira sua conexão e as origens autorizadas.';}
}
async function googleLogin(response){try{
 const data=await api('login',{method:'POST',body:{credential:response.credential}});const guest=library;accountEpoch++;user=data.user;config.csrf=data.csrf;version=data.version;library=normalizeLibrary(data.library);syncPaused=false;hydrateListening(data.listening,data.listeningUpdatedAt);updateAccount();saveLibrary();renderPage();
 if(guest.favorites.length||guest.playlists.length){modal('Levar sua biblioteca para a conta?',`<p>Você tem músicas salvas neste navegador. Podemos adicioná-las à biblioteca de ${escape(user.name||'sua conta')}.</p><div class="modal-actions"><button class="button button-secondary" data-action="close-modal">Usar biblioteca da conta</button><button id="merge-guest" class="button button-primary">Adicionar músicas locais</button></div>`);$('#merge-guest').onclick=()=>{library=mergeLibraries(guest,library);saveLibrary();closeModal();renderPage();toast('Bibliotecas unidas');};}else{closeModal();toast('Conta conectada');}
 }catch(error){if($('#google-error'))$('#google-error').textContent=error.message;else toast(error.message);}}
function updateAccount(){$('#account-label').textContent=user?(user.name||'Minha conta'):'Entrar com Google';$('.avatar').textContent=user?(user.name||user.email||'U').slice(0,1).toUpperCase():'G';$('#save-status').textContent=user?'Biblioteca da conta':'Salvo neste navegador';}
async function syncLibrary(){
 if(!user||syncPaused||syncing)return;syncing=true;const epoch=accountEpoch,rev=revision;try{const data=await api('library',{method:'PUT',body:{library,version}});if(epoch!==accountEpoch)return;version=data.version;if(rev===revision){try{localStorage.setItem(storageKey()+':sync',JSON.stringify({dirty:false,version}));}catch{}}$('#save-status').textContent='Biblioteca sincronizada';if(rev!==revision){syncing=false;return syncLibrary();}}
 catch(error){if(epoch!==accountEpoch)return;$('#save-status').textContent='Salvo localmente · sem sincronizar';if(error.status===409){syncPaused=true;modal('Biblioteca atualizada em outra tela',`<p>Para evitar substituir alterações de outro dispositivo, a sincronização foi pausada. Você pode carregar a biblioteca da conta ou unir suas alterações.</p><div class="modal-actions"><button class="button button-secondary" data-action="reload-cloud">Carregar da conta</button><button class="button button-primary" data-action="merge-cloud">Unir bibliotecas</button></div>`);}else toast('Alterações salvas neste navegador. A sincronização será tentada quando a conexão voltar.');}
 finally{syncing=false;}
}
async function reloadCloud(merge){const epoch=accountEpoch;try{const data=await api('library');if(epoch!==accountEpoch)return;library=merge?mergeLibraries(library,data.library):normalizeLibrary(data.library);version=data.version;syncPaused=false;saveLibrary();closeModal();renderPage();}catch(error){toast(error.message);}}
async function logout(){clearTimeout(syncTimer);clearTimeout(listeningTimer);if(user){await syncListening();if(!syncPaused)await syncLibrary();}if(syncPaused){toast('Exporte sua biblioteca e resolva o conflito antes de sair.');return;}try{await api('logout',{method:'POST',body:{}});accountEpoch++;desiredPlayback=false;if(playerReady)player.pauseVideo();setPlaying(false);user=null;library=readLibrary(STORAGE_KEY);version=0;config=await api('config');restoreGuestListening();updateAccount();renderPage();closeModal();toast('Você saiu da conta');}catch(error){toast(error.message);}}
async function deleteAccount(){modal('Excluir dados da conta?',`<p>Isso remove do servidor suas favoritas, playlists, histórico e preferências do 4uMusic. Sua conta Google e seus dados do YouTube não serão alterados.</p><p>Exporte sua biblioteca antes, se quiser guardar uma cópia.</p><div class="modal-actions"><button class="button button-secondary" data-action="close-modal">Cancelar</button><button id="confirm-delete-account" class="button button-primary">Excluir meus dados</button></div>`);$('#confirm-delete-account').onclick=async()=>{try{clearTimeout(syncTimer);clearTimeout(listeningTimer);while(syncing||listeningBusy)await new Promise(r=>setTimeout(r,50));const key=storageKey(),profile=listeningKey(),queueKey=QUEUE_KEY+':'+user.id;await api('account',{method:'DELETE',body:{}});accountEpoch++;localStorage.removeItem(key);localStorage.removeItem(profile);sessionStorage.removeItem(queueKey);desiredPlayback=false;if(playerReady)player.pauseVideo();setPlaying(false);user=null;library=readLibrary(STORAGE_KEY);config=await api('config');restoreGuestListening();updateAccount();renderPage();closeModal();toast('Dados da conta excluídos');}catch(error){toast(error.message);}};}
document.addEventListener('click',async event=>{
 const el=event.target.closest('[data-action],[data-view]');if(!el||el.disabled)return;
 if(el.dataset.view){navigate(el.dataset.view);if(view==='search')$('#search-input').focus();return;}
 const action=el.dataset.action,track=getTrack(el.dataset.id);
 switch(action){
 case 'go-home':navigate('home');break;case 'discover':navigate('search');$('#search-input').focus();break;
 case 'resume':if(currentTrack()){resumeStart=resumeSeconds;playTrack(currentTrack(),{index:currentIndex});}break;
 case 'menu':$('#sidebar').classList.toggle('open');el.setAttribute('aria-expanded',String($('#sidebar').classList.contains('open')));break;
 case 'focus-search':$('#search-input').focus();break;case 'add-link':openLinkDialog();break;case 'close-modal':closeModal();break;
 case 'retry-search':await search(searchQuery);break;case 'recent-search':await search(el.dataset.query);break;case 'clear-searches':recentSearches=[];if(!user)try{localStorage.removeItem(SEARCH_KEY);}catch{}persistListening(1500);renderSearch();break;
 case 'help':showHelp();break;case 'setup':showSetup();break;case 'account':showAccount();break;case 'logout':await logout();break;case 'delete-account':deleteAccount();break;
 case 'premium-info':modal('Quem cuida dos anúncios é o YouTube.',`<p>O 4uMusic usa o player oficial. Contas gratuitas podem receber anúncios. Uma conta YouTube Premium pode ter o benefício aplicado quando o player reconhecer a sessão e os cookies do navegador.</p><p>Entrar com Google no 4uMusic não autentica automaticamente o player. YouTube Music Premium e YouTube Premium têm benefícios diferentes. Não conseguimos detectar ou garantir o Premium pela API do player.</p><a href="https://support.google.com/youtube/answer/7437519?hl=pt-BR" target="_blank" rel="noopener noreferrer">Orientações do YouTube ↗</a>`);break;
 case 'genre':await search(el.dataset.query==='Tudo'?'música vídeo oficial':el.dataset.query+' música vídeo oficial',{kind:'video'});break;
 case 'mix':await search(mixes[Number(el.dataset.index)].query,{kind:'video'});break;
 case 'mix-mode':mixMode=el.dataset.mode;radioPages.clear();radioController?.abort();radioTask=null;persistListening(1500);renderPage();toast(mixMode==='similar'?'Mix: músicas mais parecidas':mixMode==='discovery'?'Mix: descobrir novidades':'Mix: variar artistas');if(playing)prefetchRadio();break;
 case 'artist-lookup':await search(el.dataset.name,{kind:'channel'});break;
 case 'open-artist':await openArtist(el.dataset.id);break;
 case 'artist-more':await loadArtistTracks();break;
 case 'artist-albums':await loadArtistAlbums();break;
 case 'play-artist':playCollection(artistTracks);break;
 case 'search-kind':searchKind=el.dataset.kind;if(searchQuery)await search(searchQuery);else renderSearch();break;
 case 'more-search':await search(searchQuery,{append:true});break;
 case 'more-playlist':await moreYouTubePlaylist();break;
 case 'youtube-search':window.open('https://www.youtube.com/results?search_query='+encodeURIComponent(searchQuery||'música'),'_blank','noopener,noreferrer');break;
 case 'play-track':playTrack(track);break;case 'favorite-track':toggleFavorite(track);break;case 'favorite-current':toggleFavorite(currentTrack());break;case 'track-options':if(track)trackOptions(track);break;
 case 'play-selected':closeModal();playTrack(selectionTrack);break;case 'enqueue-selected':enqueue(selectionTrack);closeModal();break;case 'next-selected':enqueue(selectionTrack,{next:true});closeModal();break;case 'playlist-selected':choosePlaylist(selectionTrack);break;case 'favorite-selected':toggleFavorite(selectionTrack);closeModal();break;case 'versions-selected':closeModal();search(selectionTrack.title,{kind:'video'});break;
 case 'dislike-selected':{const id=selectionTrack?.id;if(!id)break;if(taste.disliked.includes(id))taste.disliked=taste.disliked.filter(value=>value!==id);else rememberTaste('disliked',id);if(!user)try{localStorage.setItem(TASTE_KEY,JSON.stringify(taste));}catch{}persistListening(1500);closeModal();toast(taste.disliked.includes(id)?'Esta música não aparecerá nas sugestões':'Esta música pode voltar às sugestões');break;}
 case 'rename-selected':modal('Editar nome',`<form id="track-name-form"><label class="form-label" for="track-name">Nome na sua biblioteca</label><input id="track-name" class="form-input" maxlength="240" required value="${escape(selectionTrack.title)}"><div class="modal-actions"><button class="button button-primary">Salvar nome</button></div></form>`);break;
 case 'create-playlist':playlistDialog();break;case 'create-for-track':playlistDialog({addTrack:selectionTrack});break;case 'open-playlist':navigate('playlist',el.dataset.id);break;case 'rename-playlist':playlistDialog({rename:true});break;
 case 'add-to-playlist':{const list=library.playlists.find(item=>item.id===el.dataset.id);if(list&&selectionTrack){if(list.tracks.some(item=>item.id===selectionTrack.id)){toast('Essa música já está na playlist.');return;}if(list.tracks.length>=2000){toast('Limite de 2.000 músicas por playlist.');return;}list.tracks.push(normalizeTrack(selectionTrack));saveLibrary();closeModal();if(view==='playlist')renderPage();toast('Música adicionada à playlist');}break;}
 case 'select-track':{if(el.checked)selectedTracks.add(el.dataset.id);else selectedTracks.delete(el.dataset.id);const toolbar=$('[data-action="remove-selected"]');if(toolbar){toolbar.disabled=!selectedTracks.size;toolbar.textContent=`Remover selecionadas (${selectedTracks.size})`;}break;}
 case 'remove-selected':{const list=view==='favorites'?library.favorites:library.playlists.find(item=>item.id===selectedPlaylist)?.tracks;if(!list||!selectedTracks.size)break;const before=[...list],ids=new Set(selectedTracks),removed=ids.size;if(view==='favorites')library.favorites=list.filter(item=>!ids.has(item.id));else{const target=library.playlists.find(item=>item.id===selectedPlaylist);target.tracks=list.filter(item=>!ids.has(item.id));}const listId=selectedPlaylist,source=view;selectedTracks.clear();saveLibrary();renderPage();toast(`${removed} música(s) removida(s).`,'Desfazer',()=>{if(source==='favorites')library.favorites=restoreRemoved(library.favorites,before,ids);else{const target=library.playlists.find(item=>item.id===listId);if(target)target.tracks=restoreRemoved(target.tracks,before,ids);}saveLibrary();renderPage();});break;}
 case 'remove-track':{const list=library.playlists.find(item=>item.id===el.dataset.list);if(list){const before=[...list.tracks];list.tracks=list.tracks.filter(item=>item.id!==el.dataset.id);saveLibrary();renderPage();toast('Música removida da playlist.','Desfazer',()=>{list.tracks=restoreRemoved(list.tracks,before,new Set([el.dataset.id]));saveLibrary();renderPage();});}break;}
 case 'move-up':movePlaylist(el.dataset.list,Number(el.dataset.index),Number(el.dataset.index)-1);break;case 'move-down':movePlaylist(el.dataset.list,Number(el.dataset.index),Number(el.dataset.index)+1);break;
 case 'delete-playlist':{const list=library.playlists.find(item=>item.id===selectedPlaylist);modal('Excluir esta playlist?',`<p>“${escape(list.name)}” será removida da sua biblioteca. As músicas favoritas serão preservadas.</p><div class="modal-actions"><button class="button button-secondary" data-action="close-modal">Cancelar</button><button id="confirm-delete" class="button button-primary">Excluir playlist</button></div>`);$('#confirm-delete').onclick=()=>{const position=library.playlists.findIndex(item=>item.id===list.id);library.playlists=library.playlists.filter(item=>item.id!==list.id);saveLibrary();closeModal();navigate('library');toast('Playlist excluída.','Desfazer',()=>{if(!library.playlists.some(other=>other.id===list.id)){library.playlists.splice(Math.min(position,library.playlists.length),0,list);saveLibrary();renderPage();}});};break;}
 case 'share-playlist':await sharePlaylist();break;case 'export':exportLibrary();break;case 'import':$('#import-file').click();break;
 case 'play-playlist':playCollection(library.playlists.find(item=>item.id===selectedPlaylist)?.tracks||[]);break;case 'play-favorites':playCollection(library.favorites);break;case 'queue-catalog':playCollection(catalog);break;case 'play-shared':playCollection(remotePlaylist?.tracks||[]);break;
 case 'save-shared':if(remotePlaylist){if(remotePlaylistPage){toast('Carregue todas as músicas antes de salvar a playlist completa.');return;}if(library.playlists.length>=100){toast('Limite de 100 playlists.');return;}const list={...remotePlaylist,id:uid(),tracks:uniqueTracks(remotePlaylist.tracks)};library.playlists.push(list);saveLibrary();navigate('playlist',list.id);toast('Playlist salva na biblioteca');}break;
 case 'open-youtube-playlist':await openYouTubePlaylist(el.dataset.id);break;
 case 'toggle-play':if(playing||nextOperation){desiredPlayback=false;transportEpoch++;if(playerReady)player.pauseVideo();setPlaying(false);break;}desiredPlayback=true;transportEpoch++;if(!currentTrack()){openLinkDialog();break;}if(!playerReady){resumeStart=resumeSeconds;playTrack(currentTrack(),{index:currentIndex});break;}player.playVideo();break;
 case 'wake-toggle':{const enabled=!screenWakeLock.getState().enabled;try{localStorage.setItem('4umusic:keep-awake:v1',String(enabled));}catch{}await screenWakeLock.setEnabled(enabled);if(!enabled)toast('Tela ligada desativada.');else if(!playing)toast('A tela será mantida ligada enquanto a música tocar.');break;}
 case 'next':if(playing&&playerReady&&player.getCurrentTime()<20&&currentTrack())rememberTaste('skipped',currentTrack().id);nextTrack();break;case 'previous':previousTrack();break;
 case 'sleep-settings':sleepSettings();break;
 case 'sleep-minutes':clearTimeout(sleepTimer);sleepAtEnd=false;sleepUntil=Date.now()+Number(el.dataset.minutes)*60000;sleepTimer=setTimeout(stopForSleep,Number(el.dataset.minutes)*60000);closeModal();toast(`Reprodução vai parar em ${el.dataset.minutes} minutos.`);break;
 case 'sleep-end':clearTimeout(sleepTimer);sleepTimer=null;sleepUntil=0;sleepAtEnd=true;closeModal();toast('A reprodução vai parar ao terminar esta música.');break;
 case 'sleep-cancel':clearTimeout(sleepTimer);sleepTimer=null;sleepUntil=0;sleepAtEnd=false;closeModal();toast('Temporizador desativado.');break;
 case 'shuffle':{shuffle=!shuffle;const current=currentTrack(),past=queue.filter(item=>musicSession.has(item)&&item.id!==current?.id),remaining=musicSession.unheard(queue);queue=[...past,...(current?[current]:[]),...(shuffle?shuffled(remaining):remaining)];currentIndex=current?past.length:-1;renderQueue();toast(shuffle?'Ordem aleatória sem repetir':'Ordem da fila sem repetir');break;}
 case 'autoplay':autoRadio=!autoRadio;if(!autoRadio){radioController?.abort();transportEpoch++;const current=currentTrack();queue=queue.filter(track=>track.id===current?.id||musicSession.has(track)||!radioAdded.has(track.id));currentIndex=current?queue.findIndex(track=>track.id===current.id):-1;}renderQueue();if(autoRadio&&playing)prefetchRadio();toast(autoRadio?'Semelhantes serão adicionadas ao fim da coleção':'Continuação com semelhantes desativada');break;
 case 'new-session':beginQueueContext(radioSeed||currentTrack(),radioContext);musicSession.clear();if(currentTrack())musicSession.mark(currentTrack());saveMusicSession();radioPages.clear();radioError='';renderQueue();toast('Nova sessão iniciada. As faixas anteriores podem tocar novamente.');break;
 case 'mute':muted=!muted;if(playerReady)muted?player.mute():player.unMute();el.classList.toggle('active',muted);el.setAttribute('aria-pressed',String(muted));el.setAttribute('aria-label',muted?'Ativar som':'Silenciar');break;
 case 'show-player':navigate('queue');break;
 case 'queue-play':playTrack(queue[Number(el.dataset.index)],{index:Number(el.dataset.index)});break;
 case 'queue-remove':{const index=Number(el.dataset.index);if(index!==currentIndex){queue.splice(index,1);if(index<currentIndex)currentIndex--;renderQueue();}break;}
 case 'queue-up':{const from=Number(el.dataset.index),active=queue[currentIndex];queue=moveItem(queue,from,from-1);currentIndex=queue.indexOf(active);renderQueue();break;}
 case 'clear-queue':{const current=currentTrack();queue=current?[current]:[];currentIndex=current?0:-1;renderQueue();toast('Fila limpa. A música atual foi preservada.');break;}
 case 'reload-cloud':await reloadCloud(false);break;case 'merge-cloud':await reloadCloud(true);break;
 case 'install':await installApp();break;
 }
});
document.addEventListener('submit',event=>{if(event.target.id==='search-form'){event.preventDefault();$('#search-input').blur();search($('#search-input').value);}if(event.target.id==='link-form')addLink(event);if(event.target.id==='playlist-form')createPlaylist(event);if(event.target.id==='track-name-form')updateTrackName(event);});
document.addEventListener('input',event=>{if(event.target.id==='search-input'){searchController?.abort();searchSeq++;searchQuery=cleanText(event.target.value,200);searchResults=[];nextPage='';view='search';renderSidebar();renderSearch();}if(event.target.id==='library-filter'||event.target.id==='playlist-filter'){const id=event.target.id;if(id==='library-filter')libraryFilter=event.target.value;else playlistFilter=event.target.value;const cursor=event.target.selectionStart;renderPage();const input=$('#'+id);input.focus();input.setSelectionRange(cursor,cursor);}});
document.addEventListener('change',event=>{if(event.target.id==='search-official'){searchFilter=event.target.checked?'official':'all';renderSearch();}if(event.target.id==='library-sort'){librarySort=event.target.value;renderPage();}});
$('#import-file').addEventListener('change',event=>{importLibrary(event.target.files[0]);event.target.value='';});
$('#seek').addEventListener('pointerdown',()=>{seekInteracting=true;});
document.addEventListener('pointerup',()=>{seekInteracting=false;});
document.addEventListener('pointercancel',()=>{seekInteracting=false;});
$('#seek').addEventListener('keydown',()=>{seekInteracting=true;});
$('#seek').addEventListener('keyup',()=>{seekInteracting=false;});
$('#seek').addEventListener('blur',()=>{seekInteracting=false;});
$('#seek').addEventListener('change',event=>{if(playerReady&&player.getDuration()>0)player.seekTo(player.getDuration()*Number(event.target.value)/100,true);});
$('#volume').addEventListener('input',event=>{if(playerReady)player.setVolume(Number(event.target.value));try{localStorage.setItem('4umusic:player:v1',JSON.stringify({volume:Number(event.target.value)}));}catch{}});
document.addEventListener('dragstart',event=>{const row=event.target.closest('[data-drag-index]');if(!row||event.target.closest('button,a')){event.preventDefault();return;}draggingIndex=Number(row.dataset.dragIndex);event.dataTransfer.setData('text/plain',String(draggingIndex));event.dataTransfer.effectAllowed='move';});
document.addEventListener('dragover',event=>{if(event.target.closest('[data-drag-index]'))event.preventDefault();});
document.addEventListener('drop',event=>{const row=event.target.closest('[data-drag-index]');if(row&&draggingIndex!==null){event.preventDefault();movePlaylist(row.dataset.list,draggingIndex,Number(row.dataset.dragIndex));}draggingIndex=null;});
document.addEventListener('dragend',()=>draggingIndex=null);
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal')){const rect=$('#modal').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeModal();}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){$('#sidebar').classList.remove('open');$('.mobile-menu').setAttribute('aria-expanded','false');}if(event.key==='/'&&!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)&&!$('#modal').open){event.preventDefault();$('#search-input').focus();}});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();if(!isAppInstalled())installPrompt=event;updateInstallButton();});
window.addEventListener('appinstalled',()=>{installPrompt=null;installedThisSession=true;updateInstallButton();if($('#modal-body').querySelector('.install-preview'))closeModal();toast('4uMusic instalado! Abra pelo ícone na sua tela inicial.');});
standaloneMode.addEventListener('change',()=>{updateInstallButton();void lockPortrait();});
window.addEventListener('online',()=>{if(user&&!syncPaused)syncLibrary();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){desiredPlayback=false;transportEpoch++;}void screenWakeLock.setVisible(!document.hidden);pauseHiddenVideo();});
window.addEventListener('pagehide',()=>{void screenWakeLock.setVisible(false);});
window.addEventListener('pageshow',()=>{void screenWakeLock.setVisible(!document.hidden);});
window.addEventListener('scroll',pauseHiddenVideo,{passive:true});
window.addEventListener('resize',scheduleVideoVisibilityCheck);
window.addEventListener('orientationchange',scheduleVideoVisibilityCheck);
screen.orientation?.addEventListener('change',scheduleVideoVisibilityCheck);
window.visualViewport?.addEventListener('resize',scheduleVideoVisibilityCheck);
window.addEventListener('storage',event=>{if(event.key===storageKey()&&!user){library=readLibrary(STORAGE_KEY);renderPage();updateFavorites();}});
window.addEventListener('hashchange',()=>{readShared();renderPage();});
uiTimer=setInterval(()=>{if(!playerReady)return;const duration=player.getDuration(),time=player.getCurrentTime();$('#elapsed').textContent=formatTime(time);$('#duration').textContent=formatTime(duration);if(!seekInteracting)$('#seek').value=duration>0?time/duration*100:0;if(playing&&Number.isFinite(time)&&Math.abs(time-resumeSeconds)>4){resumeSeconds=Math.max(0,Math.floor(time));saveQueue();}},750);
readShared();renderPage();updateNow();renderQueue();updateInstallButton();void lockPortrait();
try{config=await api('config');if(config.user){user=config.user;version=config.version;const local=readLibrary(storageKey());let syncState={};try{syncState=JSON.parse(localStorage.getItem(storageKey()+':sync')||'{}');}catch{}library=normalizeLibrary(config.library);hydrateListening(config.listening,config.listeningUpdatedAt);updateAccount();renderPage();if(syncState.dirty){library=local;syncPaused=true;renderPage();modal('Alterações locais aguardam sincronização',`<p>Há alterações salvas neste navegador que ainda não chegaram à conta. Você pode preservar a biblioteca local, unir as duas versões ou carregar os dados do servidor.</p><div class="modal-actions"><button class="button button-secondary" data-action="export">Exportar cópia local</button><button class="button button-secondary" data-action="reload-cloud">Carregar da conta</button><button class="button button-primary" data-action="merge-cloud">Unir bibliotecas</button></div>`);}else{try{localStorage.setItem(storageKey(),JSON.stringify(library));}catch{}}}}catch{$('#save-status').textContent='Salvo neste navegador · prévia';}
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(()=>{});
