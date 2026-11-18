<?php
declare(strict_types=1);
// No audio extraction, media proxying, passwords or YouTube session cookies.
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');

$private = dirname(__DIR__) . '/private';
$configFile = getenv('FOURUMUSIC_CONFIG') ?: $private . '/config.php';
$settings = is_file($configFile) ? require $configFile : [];
function setting(string $name, mixed $fallback = ''): mixed {
    global $settings;
    $value = getenv($name);
    return $value !== false ? $value : ($settings[$name] ?? $fallback);
}
function respond(array $data, int $status = 200): never {
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}
function fail(string $message, string $code = 'request_failed', int $status = 400): never { respond(['message' => $message, 'code' => $code], $status); }
function db(): PDO {
    static $db = null;
    if ($db instanceof PDO) return $db;
    global $private;
    if (!is_dir($private)) mkdir($private, 0700, true);
    $file = (string) setting('DATABASE_PATH', $private . '/4umusic.sqlite');
    $db = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    @chmod($file, 0600);
    $db->exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000;');
    $db->exec('CREATE TABLE IF NOT EXISTS libraries (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS listening_profiles (user_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS api_cache (cache_key TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
    return $db;
}
function limitRequest(string $scope, int $max, int $seconds): void {
    $bucket = $scope . ':' . (string) intdiv(time(), $seconds);
    $query = db()->prepare('INSERT INTO limits(bucket,hits,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 RETURNING hits');
    $query->execute([$bucket, time() + $seconds]);
    if ((int) $query->fetchColumn() > $max) { header('Retry-After: ' . $seconds); fail('Muitas solicitações. Aguarde um pouco antes de tentar novamente.', 'rate_limited', 429); }
    db()->prepare('DELETE FROM limits WHERE expires_at < ?')->execute([time() - 3600]);
}
function cached(string $key): ?array {
    $query = db()->prepare('SELECT data FROM api_cache WHERE cache_key=? AND expires_at>?'); $query->execute([$key, time()]);
    $value = $query->fetchColumn(); return $value === false ? null : json_decode($value, true);
}
function cachePut(string $key, array $value, int $ttl): void {
    db()->prepare('INSERT INTO api_cache(cache_key,data,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at')->execute([$key,json_encode($value),time()+$ttl]);
    db()->prepare('DELETE FROM api_cache WHERE expires_at < ?')->execute([time()]);
}
function getJson(string $url, array $headers = []): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>12,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_PROTOCOLS=>CURLPROTO_HTTPS,CURLOPT_HTTPHEADER=>array_merge(['Accept: application/json'], $headers),CURLOPT_USERAGENT=>'4uMusic/1.0 (+https://4u.ia.br/)']);
    $result = curl_exec($ch); $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    if ($result === false || strlen($result) > 2_000_000) return ['status'=>502,'data'=>[]];
    return ['status'=>$status,'data'=>json_decode($result,true) ?: []];
}
function youtube(string $resource, array $params): array {
    $key = (string) setting('YOUTUBE_API_KEY');
    if ($key === '') fail('A chave da YouTube Data API ainda não foi configurada. Enquanto isso, busque no YouTube e cole o link aqui.', 'search_not_configured', 503);
    $cacheKey = 'youtube:' . $resource . ':' . hash('sha256', json_encode($params));
    if ($hit = cached($cacheKey)) return $hit;
    limitRequest('youtube:all', 500, 86400);
    if ($resource === 'search') {
        if(($_GET['purpose']??'manual')==='radio')limitRequest('radio:daily',25,86400);
        limitRequest('youtube:search', max(1,(int)setting('SEARCH_DAILY_LIMIT',90)), 86400);
    }
    $result = getJson('https://www.googleapis.com/youtube/v3/' . $resource . '?' . http_build_query($params), ['X-Goog-Api-Key: ' . $key]);
    if ($result['status'] !== 200) {
        $reason = $result['data']['error']['errors'][0]['reason'] ?? '';
        if (in_array($reason,['quotaExceeded','dailyLimitExceeded','rateLimitExceeded'],true)) fail('A cota de busca do YouTube foi atingida. Você ainda pode ouvir pelos links e pelas suas playlists.', 'youtube_quota', 429);
        fail('O YouTube não aceitou a consulta. Confira a chave, a ativação da API e suas restrições no servidor.', 'youtube_unavailable', 502);
    }
    cachePut($cacheKey,$result['data'],3600); return $result['data'];
}
function textValue(mixed $value, int $max = 240): string {
    if (!is_string($value)) return '';
    return mb_substr(trim(preg_replace('/[\x00-\x1f\x7f]/u','',$value) ?? ''),0,$max);
}
function trackValue(mixed $value): ?array {
    if (!is_array($value) || !preg_match('/^[A-Za-z0-9_-]{11}$/D',(string)($value['id']??''))) return null;
    return ['id'=>$value['id'],'title'=>textValue($value['title']??'Vídeo do YouTube') ?: 'Vídeo do YouTube','artist'=>textValue($value['artist']??'YouTube',160) ?: 'YouTube','addedAt'=>max(0,min(9007199254740991,(int)($value['addedAt']??time()*1000)))];
}
function tracksValue(mixed $values): array {
    if (!is_array($values) || count($values)>2000) fail('Limite de 2.000 músicas por lista.', 'invalid_library');
    $tracks=[]; foreach($values as $item) { $track=trackValue($item); if($track)$tracks[$track['id']]=$track; }
    return array_values($tracks);
}
function libraryValue(mixed $value): array {
    if (!is_array($value) || ($value['schema']??null)!==1 || !is_array($value['playlists']??null) || count($value['playlists'])>100) fail('Biblioteca inválida ou acima do limite.', 'invalid_library');
    $lists=[]; foreach($value['playlists'] as $list) {
        if (!is_array($list)||!preg_match('/^[A-Za-z0-9_-]{1,80}$/D',(string)($list['id']??''))) fail('Identificador de playlist inválido.','invalid_library');
        $lists[$list['id']]=['id'=>$list['id'],'name'=>textValue($list['name']??'Minha playlist',80) ?: 'Minha playlist','tracks'=>tracksValue($list['tracks']??[])];
    }
    return ['schema'=>1,'favorites'=>tracksValue($value['favorites']??[]),'playlists'=>array_values($lists)];
}
function libraryGet(string $id): array {
    $query=db()->prepare('SELECT data,version FROM libraries WHERE user_id=?');$query->execute([$id]);$row=$query->fetch();
    return ['library'=>$row?json_decode($row['data'],true):['schema'=>1,'favorites'=>[],'playlists'=>[]],'version'=>$row?(int)$row['version']:0];
}
function listeningGet(string $id): array {
    $query=db()->prepare('SELECT data,updated_at FROM listening_profiles WHERE user_id=?');$query->execute([$id]);$row=$query->fetch();
    return ['listening'=>$row?json_decode($row['data'],true):null,'listeningUpdatedAt'=>$row?(int)$row['updated_at']:0];
}
function listeningValue(mixed $value): array {
    if(!is_array($value))fail('Histórico de reprodução inválido.','invalid_listening');
    $ids=[];foreach(['disliked','skipped'] as $kind){$values=is_array($value[$kind]??null)?$value[$kind]:[];$ids[$kind]=array_values(array_unique(array_filter(array_slice($values,0,200),fn($id)=>is_string($id)&&preg_match('/^[A-Za-z0-9_-]{11}$/D',$id))));}
    $searches=[];foreach(array_slice(is_array($value['searches']??null)?$value['searches']:[],0,8) as $term){$term=textValue($term,200);if($term!=='')$searches[]=$term;}
    $queue=tracksValue(array_slice(is_array($value['queue']??null)?$value['queue']:[],0,200));
    $seed=trackValue($value['seed']??null);
    $mode=(string)($value['mixMode']??'varied');if(!in_array($mode,['similar','varied','discovery'],true))$mode='varied';
    return ['recent'=>tracksValue(array_slice(is_array($value['recent']??null)?$value['recent']:[],0,30)),'searches'=>array_values(array_unique($searches)),'disliked'=>$ids['disliked'],'skipped'=>$ids['skipped'],'queue'=>$queue,'index'=>max(-1,min(count($queue)-1,(int)($value['index']??-1))),'seconds'=>max(0,min(86400,(int)($value['seconds']??0))),'seed'=>$seed,'context'=>textValue($value['context']??'',100),'autoRadio'=>($value['autoRadio']??true)!==false,'shuffle'=>($value['shuffle']??true)!==false,'mixMode'=>$mode];
}
function body(): array {
    if ((int)($_SERVER['CONTENT_LENGTH']??0)>2_000_000) fail('O envio deve ter até 2 MB.','body_too_large',413);
    if (!str_starts_with(strtolower($_SERVER['CONTENT_TYPE']??''),'application/json')) fail('Envie JSON.','invalid_content_type',415);
    $raw=file_get_contents('php://input',false,null,0,2_000_001);
    if ($raw===false||strlen($raw)>2_000_000) fail('O envio deve ter até 2 MB.','body_too_large',413);
    try { $data=json_decode($raw,true,64,JSON_THROW_ON_ERROR); } catch(Throwable) {fail('JSON inválido.','invalid_json');}
    if(!is_array($data))fail('JSON inválido.','invalid_json');return $data;
}
function requireUser(): string {
    if (!isset($_SESSION['user']['id'])) fail('Entre com Google para sincronizar.','unauthorized',401);
    return $_SESSION['user']['id'];
}
function b64url(string $value): string|false { return base64_decode(strtr($value,'-_','+/'),true); }
function verifyGoogle(string $token): array {
    if (strlen($token)>16000)fail('Credencial inválida.','invalid_token',401);
    $parts=explode('.',$token);if(count($parts)!==3)fail('Credencial inválida.','invalid_token',401);
    $header=json_decode(b64url($parts[0])?:'',true);$payload=json_decode(b64url($parts[1])?:'',true);$sig=b64url($parts[2]);
    if(!is_array($header)||!is_array($payload)||($header['alg']??'')!=='RS256'||!is_string($header['kid']??null)||$sig===false)fail('Credencial inválida.','invalid_token',401);
    $certs=cached('google:certs');
    if(!$certs||!isset($certs[$header['kid']])){$response=getJson('https://www.googleapis.com/oauth2/v1/certs');if($response['status']!==200)fail('Não foi possível verificar o login Google.','google_unavailable',503);$certs=$response['data'];cachePut('google:certs',$certs,1800);}
    $certificate=$certs[$header['kid']]??null;
    if(!is_string($certificate)||openssl_verify($parts[0].'.'.$parts[1],$sig,$certificate,OPENSSL_ALGO_SHA256)!==1)fail('Credencial inválida.','invalid_token',401);
    $client=(string)setting('GOOGLE_CLIENT_ID','569266864432-pd09jbb5no9ekdhdr018fj643nopp817.apps.googleusercontent.com');
    if(($payload['aud']??'')!==$client||!in_array($payload['iss']??'',['https://accounts.google.com','accounts.google.com'],true)||($payload['exp']??0)<=time()||($payload['iat']??0)>time()+60||!hash_equals($_SESSION['nonce'],(string)($payload['nonce']??''))||!preg_match('/^[0-9]{1,80}$/D',(string)($payload['sub']??'')))fail('A sessão Google é inválida ou expirou. Abra o login novamente.','invalid_token',401);
    return ['id'=>$payload['sub'],'name'=>textValue($payload['name']??'Minha conta',100),'email'=>textValue($payload['email']??'',200)];
}
try {
    $secure=(!empty($_SERVER['HTTPS'])&&$_SERVER['HTTPS']!=='off')||($_SERVER['HTTP_X_FORWARDED_PROTO']??'')==='https';
    session_name('fourumusic_session');
    session_set_cookie_params(['lifetime'=>0,'path'=>rtrim(str_replace('\\','/',dirname($_SERVER['SCRIPT_NAME']??'/api.php')),'/').'/','secure'=>$secure,'httponly'=>true,'samesite'=>'Lax']);
    session_start();
    $_SESSION['csrf']??=bin2hex(random_bytes(32));$_SESSION['nonce']??=bin2hex(random_bytes(24));
    $action=(string)($_GET['action']??'config');$method=$_SERVER['REQUEST_METHOD']??'GET';
    $ip=hash('sha256',(string)($_SERVER['REMOTE_ADDR']??'local'));
    if($method!=='GET'){
        if(!hash_equals($_SESSION['csrf'],(string)($_SERVER['HTTP_X_4U_CSRF']??'')))fail('Sessão de segurança inválida. Recarregue a página.','csrf',403);
        $origin=(string)($_SERVER['HTTP_ORIGIN']??'');$allowed=(string)setting('APP_ORIGIN',($secure?'https://':'http://').($_SERVER['HTTP_HOST']??''));
        if($origin!==''&&$origin!==$allowed)fail('Origem não autorizada.','invalid_origin',403);
    }
    $googleEnabled=filter_var(setting('GOOGLE_AUTH_ENABLED',false),FILTER_VALIDATE_BOOLEAN);
    if($action==='config'&&$method==='GET'){
        $result=['searchEnabled'=>(string)setting('YOUTUBE_API_KEY')!=='','authMode'=>$googleEnabled?'google':'local','googleClientId'=>$googleEnabled?(string)setting('GOOGLE_CLIENT_ID','569266864432-pd09jbb5no9ekdhdr018fj643nopp817.apps.googleusercontent.com'):'','csrf'=>$_SESSION['csrf'],'nonce'=>$_SESSION['nonce'],'user'=>$_SESSION['user']??null];
        if(isset($_SESSION['user']))$result+=libraryGet($_SESSION['user']['id'])+listeningGet($_SESSION['user']['id']);respond($result);
    }
    if($action==='resolve'&&$method==='GET'){
        $id=(string)($_GET['id']??'');if(!preg_match('/^[A-Za-z0-9_-]{11}$/D',$id))fail('Link de vídeo inválido.','invalid_id');
        limitRequest('resolve:'.$ip,120,3600);$cache='resolve:'.$id;if($hit=cached($cache))respond($hit);
        $response=getJson('https://www.youtube.com/oembed?'.http_build_query(['url'=>'https://www.youtube.com/watch?v='.$id,'format'=>'json']));
        if($response['status']!==200)fail('Título indisponível. O link ainda pode ser adicionado.','metadata_unavailable',404);
        $data=['track'=>['id'=>$id,'title'=>textValue($response['data']['title']??'Vídeo do YouTube'),'artist'=>textValue($response['data']['author_name']??'YouTube',160)]];cachePut($cache,$data,3600);respond($data);
    }
    if($action==='search'&&$method==='GET'){
        $q=textValue($_GET['q']??'',200);
        limitRequest('search:'.$ip,40,3600);
        $purpose=(string)($_GET['purpose']??'manual');
        if(!in_array($purpose,['manual','radio'],true))fail('Tipo de busca inválido.','invalid_purpose');
        $kind=(string)($_GET['kind']??'video');if(!in_array($kind,['video','playlist','channel'],true))fail('Tipo de busca inválido.','invalid_kind');
        $channel=textValue($_GET['channel']??'',40);
        if($channel!==''&&($kind!=='video'||!preg_match('/^UC[A-Za-z0-9_-]{22}$/D',$channel)))fail('Canal inválido.','invalid_channel');
        if($q===''&&$channel==='')fail('Digite uma busca.','empty_query');
        $params=['part'=>'snippet','type'=>$kind,'maxResults'=>20,'regionCode'=>'BR','relevanceLanguage'=>'pt','safeSearch'=>'moderate'];
        if($q!=='')$params['q']=$q;
        if($channel!==''){$params['channelId']=$channel;$params['order']='viewCount';}
        if($kind==='video')$params+=['videoEmbeddable'=>'true','videoSyndicated'=>'true','videoCategoryId'=>'10'];
        $page=textValue($_GET['page']??'',200);if($page!=='')$params['pageToken']=$page;
        $data=youtube('search',$params);$items=[];
        foreach($data['items']??[] as $item){$snippet=$item['snippet'];$id=$item['id'][$kind.'Id']??'';if($id==='')continue;
            $thumb=$snippet['thumbnails']['medium']['url']??$snippet['thumbnails']['default']['url']??'';
            if(!preg_match('~^https://[a-zA-Z0-9.-]+\.(ytimg\.com|googleusercontent\.com|ggpht\.com)/~',$thumb))$thumb='assets/icon.svg';
            $items[]=['id'=>$id,'title'=>html_entity_decode(textValue($snippet['title']),ENT_QUOTES|ENT_HTML5,'UTF-8'),'artist'=>textValue($snippet['channelTitle']),'thumbnail'=>$thumb];}
        respond(['items'=>$items,'nextPage'=>$data['nextPageToken']??'']);
    }
    if($action==='playlist'&&$method==='GET'){
        $id=textValue($_GET['id']??'',100);if(!preg_match('/^[A-Za-z0-9_-]{10,100}$/D',$id))fail('Playlist inválida.','invalid_id');limitRequest('playlist:'.$ip,60,3600);
        $params=['part'=>'snippet','playlistId'=>$id,'maxResults'=>50];
        $page=textValue($_GET['page']??'',200);if($page!=='')$params['pageToken']=$page;
        $data=youtube('playlistItems',$params);$items=[];
        foreach($data['items']??[] as $item){$s=$item['snippet'];if(in_array($s['title']??'',['Deleted video','Private video'],true))continue;$track=trackValue(['id'=>$s['resourceId']['videoId']??'','title'=>$s['title']??'','artist'=>$s['videoOwnerChannelTitle']??$s['channelTitle']??'YouTube']);if($track)$items[]=$track;}
        respond(['items'=>$items,'nextPage'=>$data['nextPageToken']??'']);
    }
    if($action==='login'&&$method==='POST'){
        if(!$googleEnabled)fail('Login Google ainda não ativado neste servidor.','auth_not_configured',503);limitRequest('login:'.$ip,20,3600);
        $data=body();$user=verifyGoogle((string)($data['credential']??''));session_regenerate_id(true);$_SESSION['user']=$user;$_SESSION['csrf']=bin2hex(random_bytes(32));$_SESSION['nonce']=bin2hex(random_bytes(24));respond(['user'=>$user,'csrf'=>$_SESSION['csrf']]+libraryGet($user['id'])+listeningGet($user['id']));
    }
    if($action==='logout'&&$method==='POST'){body();unset($_SESSION['user']);session_regenerate_id(true);$_SESSION['csrf']=bin2hex(random_bytes(32));$_SESSION['nonce']=bin2hex(random_bytes(24));respond(['ok'=>true]);}
    if($action==='library'&&$method==='GET')respond(libraryGet(requireUser()));
    if($action==='listening'&&$method==='GET')respond(listeningGet(requireUser()));
    if($action==='listening'&&$method==='PUT'){
        $id=requireUser();$profile=listeningValue(body()['listening']??null);$updated=(int)floor(microtime(true)*1000);
        db()->prepare('INSERT INTO listening_profiles(user_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at')->execute([$id,json_encode($profile,JSON_UNESCAPED_UNICODE),$updated]);respond(['listeningUpdatedAt'=>$updated]);
    }
    if($action==='library'&&$method==='PUT'){
        $id=requireUser();$data=body();$library=libraryValue($data['library']??null);$version=$data['version']??null;if(!is_int($version)||$version<0)fail('Versão inválida.','invalid_version');
        $db=db();$db->exec('BEGIN IMMEDIATE');$old=libraryGet($id);if($old['version']!==$version){$db->exec('ROLLBACK');fail('A biblioteca mudou em outro dispositivo.','version_conflict',409);}
        $next=$version+1;$db->prepare('INSERT INTO libraries(user_id,data,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at')->execute([$id,json_encode($library,JSON_UNESCAPED_UNICODE),$next,time()]);$db->exec('COMMIT');respond(['version'=>$next]);
    }
    if($action==='account'&&$method==='DELETE'){$id=requireUser();body();db()->prepare('DELETE FROM libraries WHERE user_id=?')->execute([$id]);db()->prepare('DELETE FROM listening_profiles WHERE user_id=?')->execute([$id]);unset($_SESSION['user']);session_regenerate_id(true);$_SESSION['csrf']=bin2hex(random_bytes(32));$_SESSION['nonce']=bin2hex(random_bytes(24));respond(['ok'=>true]);}
    fail('Rota ou método não disponível.','not_found',404);
} catch(Throwable $error) { fail('O serviço encontrou um erro. Confira as permissões do banco e a configuração do servidor.','server_error',500); }
