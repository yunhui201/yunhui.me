"""Publish verified default catalog models, retaining custom providers and availability choices."""
import argparse,json,posixpath,shlex
from pathlib import Path
from datetime import datetime,timezone
from remote_ssh import connect,execute
parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
root=Path(__file__).resolve().parents[1];seed=json.loads((root/'server/seed-catalog.json').read_text(encoding='utf-8'))
print('Verified defaults:',len(seed['providers']),'vendors,',sum(len(p.get('models',[])) for p in seed['providers']),'models')
if not args.apply:raise SystemExit('Use --apply to publish after reviewing model sources.')
stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ');backup='/www/aurora-backups/catalog-'+stamp
php='''<?php
require '/www/wwwroot/yunhui.me/lib.php';
$lock=fopen(data_path('catalog-write.lock'),'c');if(!$lock||!flock($lock,LOCK_EX))throw new RuntimeException('lock unavailable');
$current=catalog();$seed=json_decode(file_get_contents(__DIR__.'/seed.json'),true,512,JSON_THROW_ON_ERROR);
if(!copy(data_path('catalog.json'),__DIR__.'/catalog-before.json'))throw new RuntimeException('backup failed');
$existing=[];foreach($current['providers'] as $i=>$p)$existing[$p['key']]=$i;
$updated=0;$added=0;
foreach($seed['providers'] as $provider){$next=normalize_provider($provider);$key=$next['key'];
 if(isset($existing[$key])){$i=$existing[$key];$old=$current['providers'][$i];$next=array_merge($old,$next);foreach(['enabled','sort','createdAt'] as $field)if(array_key_exists($field,$old))$next[$field]=$old[$field];$current['providers'][$i]=$next;$updated++;}
 else{$current['providers'][]=$next;$added++;}}
save_catalog($current);echo json_encode(['ok'=>true,'version'=>$current['version'],'updated'=>$updated,'added'=>$added,'providers'=>count($current['providers'])],JSON_UNESCAPED_UNICODE).PHP_EOL;
'''
with connect() as client:
 execute(client,'mkdir -p '+shlex.quote(backup)+' && chmod 700 '+shlex.quote(backup))
 with client.open_sftp() as sftp:
  with sftp.open(backup+'/seed.json','w') as f:f.write(json.dumps(seed,ensure_ascii=False))
  with sftp.open(backup+'/apply.php','w') as f:f.write(php)
  sftp.chmod(backup+'/seed.json',0o600);sftp.chmod(backup+'/apply.php',0o600)
 print(execute(client,'/www/server/php/82/bin/php '+shlex.quote(backup+'/apply.php')).strip())
 execute(client,'chown www:www /www/aurora-data/catalog.json /www/aurora-data/catalog-write.lock && chmod 600 /www/aurora-data/catalog.json /www/aurora-data/catalog-write.lock')
 print('Original catalog retained:',backup+'/catalog-before.json')
